import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { HaClient, EntityState } from "./ha.js";
import { runGoal } from "./agent.js";
import { Store, Goal } from "./store.js";
import { Budget } from "./budget.js";

const cfg = loadConfig();
const ha = new HaClient(cfg);
const budget = new Budget(cfg.maxLlmCallsPerHour, cfg.maxLlmCallsPerDay);
const log = (m: string) => console.log(`[cooper ${new Date().toISOString()}] ${m}`);

// Durable store (SQLite). Watch-goals persist across restarts; do-goals are one-shot/in-memory.
// `goals` is the hot-path in-memory cache, write-through to the store on every mutation.
const store = new Store();
const goals: Goal[] = store.watchGoals();
let tmpId = -1; // transient ids for one-shot do-goals (never collide with SQLite rowids)
const COOLDOWN_MS = 120_000; // min gap between evaluations of the same watch-goal

log(`starting — model=${cfg.model}, observe=${cfg.observeMode}, search=${cfg.searchProvider}; ${goals.length} watch-goal(s) restored`);

// ---- HTTP control surface: /healthz, POST /goal {text,type}, DELETE /goal/:id ----
createServer(async (req, res) => {
  const json = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/healthz")
    return json(200, { ok: true, observe: cfg.observeMode, budget: budget.stats(Date.now()), goals: goals.map((g) => ({ id: g.id, type: g.type, text: g.text })) });
  if (req.method === "POST" && req.url === "/goal") {
    let raw = ""; for await (const c of req) raw += c;
    const { text, type } = JSON.parse(raw || "{}");
    if (!text) return json(400, { error: "text required" });
    const isWatch = type === "watch";
    const now = Date.now();
    const g: Goal = isWatch
      ? store.addGoal(text, now, 0) // persisted (gets a real rowid)
      : { id: tmpId--, text, type: "do", created: now, lastRun: 0 }; // transient one-shot
    goals.push(g);
    try {
      const result = await runGoal(cfg, ha, text, isWatch ? "(initial check — establish what's normal)" : "", budget);
      g.lastRun = Date.now();
      if (isWatch) store.touchGoal(g.id, g.lastRun);
      else goals.splice(goals.indexOf(g), 1); // do-goals are one-shot, never persisted
      store.logAction(now, g.id, isWatch ? "watch:create" : "do:run", String(result).slice(0, 500));
      return json(200, { id: g.id, type: g.type, result });
    } catch (e) {
      if (isWatch) { store.deleteGoal(g.id); goals.splice(goals.indexOf(g), 1); } // roll back failed watch
      return json(500, { error: String(e) });
    }
  }
  if (req.method === "DELETE" && req.url?.startsWith("/goal/")) {
    const id = Number(req.url.split("/")[2]); const i = goals.findIndex((g) => g.id === id);
    if (i < 0) return json(404, { error: "no such goal" });
    goals.splice(i, 1); store.deleteGoal(id);
    return json(200, { deleted: id });
  }
  json(404, { error: "not found" });
}).listen(8099, () => log("http on :8099"));

// ---- Watch engine: react to RELEVANT home events (filtered + debounced + cooldown) ----
const WATCH_DOMAINS = new Set(["binary_sensor", "lock", "cover", "alarm_control_panel", "person"]);
const WATCH_CLASSES = new Set(["motion", "door", "window", "occupancy", "presence", "opening", "garage_door", "smoke", "gas", "moisture", "safety"]);
let buffer: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function interesting(entityId: string, st: EntityState): boolean {
  const domain = entityId.split(".")[0];
  if (domain === "binary_sensor") {
    const dc = st.attributes?.device_class as string | undefined;
    return dc ? WATCH_CLASSES.has(dc) : false;
  }
  return WATCH_DOMAINS.has(domain);
}

const WATCH_REQUEST = "input_text.cooper_watch_request"; // bridge from the HA conversation agent

ha.subscribe((entityId, st) => {
  // Bridge: phone/voice Cooper writes a watch request into this helper → register a watch-goal.
  if (entityId === WATCH_REQUEST && st.state && st.state.trim()) {
    const text = st.state.trim();
    const g = store.addGoal(text, Date.now(), Date.now()); // persisted watch-goal
    goals.push(g);
    log(`📥 watch-goal from HA conversation: "${text}" (#${g.id})`);
    store.logAction(g.created, g.id, "watch:create", `bridge: ${text}`);
    runGoal(cfg, ha, text, "(initial check — establish what's normal)", budget)
      .then((r) => log(`   → ${r}`)).catch((e) => log(`   intake error: ${e}`));
    ha.callService("input_text", "set_value", { entity_id: WATCH_REQUEST, value: "" }).catch(() => {}); // clear for next time
    return;
  }
  if (!goals.some((g) => g.type === "watch")) return;
  if (!interesting(entityId, st)) return;
  buffer.push(`${new Date().toISOString()}  ${entityId} -> ${st.state}`);
  if (timer) clearTimeout(timer);
  timer = setTimeout(processBuffer, 3000); // debounce: settle 3s after the last event
});

async function processBuffer() {
  const events = buffer; buffer = []; timer = null;
  const ctx = `Recent home events:\n${events.join("\n")}`;
  const now = Date.now();
  const gate = budget.canRun(now);
  if (!gate.ok) { log(`💸 skip watch eval — ${gate.reason}`); return; } // cost cap: pause auto evals
  for (const g of goals.filter((x) => x.type === "watch" && now - x.lastRun > COOLDOWN_MS)) {
    if (!budget.canRun(now).ok) break;
    g.lastRun = now; store.touchGoal(g.id, now);
    log(`👁 watch eval goal #${g.id} (${events.length} events)`);
    try { const r = await runGoal(cfg, ha, g.text, ctx, budget); store.logAction(now, g.id, "watch:eval", String(r).slice(0, 500)); log(`   → ${r}`); }
    catch (e) { log(`   watch goal #${g.id} error: ${e}`); }
  }
}

// ---- Heartbeat: periodic safety re-check of watch-goals (in case events were missed) ----
setInterval(async () => {
  const now = Date.now();
  for (const g of goals.filter((x) => x.type === "watch" && now - x.lastRun > COOLDOWN_MS)) {
    if (!budget.canRun(now).ok) { log(`💸 skip heartbeat — ${budget.canRun(now).reason}`); break; }
    g.lastRun = now; store.touchGoal(g.id, now);
    try { const r = await runGoal(cfg, ha, g.text, "(periodic check — no specific event)", budget); store.logAction(now, g.id, "watch:heartbeat", String(r).slice(0, 500)); log(`⏱ heartbeat goal #${g.id}: ${r}`); }
    catch (e) { log(`heartbeat goal #${g.id} error: ${e}`); }
  }
}, Math.max(60, cfg.heartbeatSeconds) * 1000);
