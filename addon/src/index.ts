import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { HaClient, EntityState } from "./ha.js";
import { runGoal } from "./agent.js";

const cfg = loadConfig();
const ha = new HaClient(cfg);
const log = (m: string) => console.log(`[cooper ${new Date().toISOString()}] ${m}`);

// Goal store (in-memory for v0.2 — TODO: persist to SQLite: goals, baselines, action log).
interface Goal { id: number; text: string; type: "watch" | "do"; created: number; lastRun: number; }
const goals: Goal[] = [];
let nextId = 1;
const COOLDOWN_MS = 120_000; // min gap between evaluations of the same watch-goal

log(`starting — model=${cfg.model}, observe=${cfg.observeMode}, search=${cfg.searchProvider}`);

// ---- HTTP control surface: /healthz, POST /goal {text,type}, DELETE /goal/:id ----
createServer(async (req, res) => {
  const json = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/healthz")
    return json(200, { ok: true, observe: cfg.observeMode, goals: goals.map((g) => ({ id: g.id, type: g.type, text: g.text })) });
  if (req.method === "POST" && req.url === "/goal") {
    let raw = ""; for await (const c of req) raw += c;
    const { text, type } = JSON.parse(raw || "{}");
    if (!text) return json(400, { error: "text required" });
    const g: Goal = { id: nextId++, text, type: type === "watch" ? "watch" : "do", created: Date.now(), lastRun: 0 };
    goals.push(g);
    try {
      const result = await runGoal(cfg, ha, text, g.type === "watch" ? "(initial check — establish what's normal)" : "");
      g.lastRun = Date.now();
      if (g.type === "do") goals.splice(goals.indexOf(g), 1); // do-goals are one-shot
      return json(200, { id: g.id, type: g.type, result });
    } catch (e) { return json(500, { error: String(e) }); }
  }
  if (req.method === "DELETE" && req.url?.startsWith("/goal/")) {
    const id = Number(req.url.split("/")[2]); const i = goals.findIndex((g) => g.id === id);
    return i >= 0 ? (goals.splice(i, 1), json(200, { deleted: id })) : json(404, { error: "no such goal" });
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

ha.subscribe((entityId, st) => {
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
  for (const g of goals.filter((x) => x.type === "watch" && now - x.lastRun > COOLDOWN_MS)) {
    g.lastRun = now;
    log(`👁 watch eval goal #${g.id} (${events.length} events)`);
    try { log(`   → ${await runGoal(cfg, ha, g.text, ctx)}`); }
    catch (e) { log(`   watch goal #${g.id} error: ${e}`); }
  }
}

// ---- Heartbeat: periodic safety re-check of watch-goals (in case events were missed) ----
setInterval(async () => {
  const now = Date.now();
  for (const g of goals.filter((x) => x.type === "watch" && now - x.lastRun > COOLDOWN_MS)) {
    g.lastRun = now;
    try { log(`⏱ heartbeat goal #${g.id}: ${await runGoal(cfg, ha, g.text, "(periodic check — no specific event)")}`); }
    catch (e) { log(`heartbeat goal #${g.id} error: ${e}`); }
  }
}, Math.max(60, cfg.heartbeatSeconds) * 1000);
