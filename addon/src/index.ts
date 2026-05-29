import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { HaClient, EntityState } from "./ha.js";
import { runGoal, Hooks } from "./agent.js";
import { Store, Goal, Task } from "./store.js";
import { Budget } from "./budget.js";
import { C, L as log, header } from "./log.js";
import { parseExpiry, wantsPresenceStandDown, wantsStandingWhileAway, parseTrigger } from "./time.js";

const cfg = loadConfig();
const ha = new HaClient(cfg);
const budget = new Budget(cfg.maxLlmCallsPerHour, cfg.maxLlmCallsPerDay);

// Durable store (SQLite). Watch-goals persist across restarts; do-goals are one-shot/in-memory.
// `goals` is the hot-path in-memory cache, write-through to the store on every mutation.
const store = new Store();
const goals: Goal[] = store.watchGoals();
const tasks: Task[] = store.tasks(); // deferred do-goals (scheduled / arrival-triggered)
const firing = new Set<number>();    // task ids mid-fire, to avoid double-firing
const armed = new Map<number, boolean>(); // whileAway goal id -> currently armed (everyone out)?
let tmpId = -1; // transient ids for one-shot do-goals (never collide with SQLite rowids)
const COOLDOWN_MS = 120_000; // min gap between evaluations of the same watch-goal

log(`${C.bold}${C.green}Cooper Guardian starting${C.reset} — model=${cfg.model}, observe=${cfg.observeMode}, caps=${cfg.maxLlmCallsPerHour}/hr ${cfg.maxLlmCallsPerDay}/day; ${goals.length} watch-goal(s) restored${cfg.briefingTime ? `; briefing @ ${cfg.briefingTime}` : ""}`);

// ---- HTTP control surface: /healthz, POST /goal {text,type}, DELETE /goal/:id ----
createServer(async (req, res) => {
  const json = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
  if (req.url === "/healthz")
    return json(200, {
      ok: true, observe: cfg.observeMode, budget: budget.stats(Date.now()),
      goals: goals.map((g) => ({ id: g.id, type: g.type, text: g.text, expires: g.expires ? new Date(g.expires).toISOString() : null, untilHome: g.untilPresent || undefined, standing: g.whileAway || undefined, armed: g.whileAway ? (armed.get(g.id) || false) : undefined })),
      tasks: tasks.map((t) => ({ id: t.id, text: t.text, runAt: t.runAt ? new Date(t.runAt).toISOString() : null, onArrival: t.onArrival })),
    });
  if (req.method === "POST" && req.url === "/goal") {
    let raw = ""; for await (const c of req) raw += c;
    let body: any;
    try { body = JSON.parse(raw || "{}"); } catch { return json(400, { error: "invalid JSON" }); }
    const { text, type, expires, run_at, on_arrival } = body;
    if (!text || typeof text !== "string") return json(400, { error: "text (string) required" });
    const isWatch = type === "watch";
    const now = Date.now();

    // A do-goal with a trigger (scheduled time and/or arrival) becomes a deferred TASK, not a
    // run-now goal. e.g. "prepare the home for my arrival" / "in an hour, warm up the house".
    if (!isWatch) {
      const parsed = parseTrigger(text, now);
      const runAt = run_at != null ? (typeof run_at === "number" ? run_at : Date.parse(run_at) || null) : parsed.runAt;
      const onArrival = on_arrival != null ? !!on_arrival : parsed.onArrival;
      if (runAt || onArrival) {
        const tk = store.addTask(text, now, runAt, onArrival); tasks.push(tk);
        const when = [runAt ? `at ${new Date(runAt).toISOString()}` : "", onArrival ? "on arrival home" : ""].filter(Boolean).join(" / ");
        header(`🗓 task #${tk.id} scheduled (${when}): "${text}"`);
        store.logAction(now, null, "task:create", `${when}: ${text}`);
        return json(200, { id: tk.id, scheduled: true, runAt: runAt ? new Date(runAt).toISOString() : null, onArrival });
      }
    }

    // expires accepts epoch ms or ISO/parseable string; if absent, infer from the goal text
    // ("...until Monday evening", "...for 2 hours"). null = open-ended.
    const expMs = expires == null ? parseExpiry(text, now) : (typeof expires === "number" ? expires : Date.parse(expires) || null);
    const standing = wantsStandingWhileAway(text);
    const g: Goal = isWatch
      ? store.addGoal(text, now, 0, expMs, wantsPresenceStandDown(text), standing) // persisted (gets a real rowid)
      : { id: tmpId--, text, type: "do", created: now, lastRun: 0, expires: null, untilPresent: false, sawAway: false, whileAway: false }; // transient one-shot
    goals.push(g);
    if (standing) { // dormant until everyone's out; checkPresence arms it
      header(`🏡 standing while-away watch registered (#${g.id}): "${text}"`);
      store.logAction(now, g.id, "watch:create", `standing while-away: ${text}`);
      await checkPresenceStandDown(now);
      return json(200, { id: g.id, type: "watch", standing: true, armed: armed.get(g.id) || false });
    }
    try {
      const result = await runGoal(cfg, ha, text, isWatch ? "(initial check — establish what's normal)" : "", budget, hooks);
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
  if (req.method === "DELETE" && req.url?.startsWith("/task/")) {
    const id = Number(req.url.split("/")[2]); const i = tasks.findIndex((t) => t.id === id);
    if (i < 0) return json(404, { error: "no such task" });
    tasks.splice(i, 1); store.deleteTask(id);
    return json(200, { deleted: id });
  }
  json(404, { error: "not found" });
  } catch (e) { // backstop: no request may ever crash the process
    log(`${C.red}request error: ${e}${C.reset}`);
    try { json(500, { error: "internal error" }); } catch { /* headers already sent */ }
  }
}).listen(8099, () => log("http on :8099"));

// Last-resort guards so a stray rejection/throw can never take the add-on down.
process.on("unhandledRejection", (e) => log(`${C.red}unhandledRejection: ${e}${C.reset}`));
process.on("uncaughtException", (e) => log(`${C.red}uncaughtException: ${e}${C.reset}`));

// ---- Watch engine: react to RELEVANT home events (filtered + debounced + cooldown) ----
const WATCH_DOMAINS = new Set(["binary_sensor", "lock", "cover", "alarm_control_panel", "person"]);
const WATCH_CLASSES = new Set(["motion", "door", "window", "occupancy", "presence", "opening", "garage_door", "smoke", "gas", "moisture", "safety"]);
let buffer: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

// Camera AI-detection sensors (person/vehicle/animal/package) often have NO device_class — match
// them by name so the most meaningful events ("a person was detected") aren't ignored.
const DETECT_NAME = /_(person|vehicle|animal|pet|package|face|baby|cry)\b/;
function interesting(entityId: string, st: EntityState): boolean {
  const domain = entityId.split(".")[0];
  if (domain === "binary_sensor") {
    const dc = st.attributes?.device_class as string | undefined;
    return (dc ? WATCH_CLASSES.has(dc) : false) || DETECT_NAME.test(entityId);
  }
  return WATCH_DOMAINS.has(domain);
}

const WATCH_REQUEST = "input_text.cooper_watch_request"; // bridge from the HA conversation agent
const WATCH_INTENT = /\b(watch|keep an eye|monitor|guard|look after|alert me|notify me if|let me know if|keep watch)\b/i;
const PAUSE_SWITCH = "input_boolean.cooper_pause"; // kill-switch: ON = halt all device actions
const notifyAll = (msg: string) => { for (const tgt of cfg.notifyTargets) ha.notify(tgt, "Cooper", msg).catch(() => {}); };

// ---- Kill-switch + interactive Yes/No confirmation (the guardrail "hooks" the agent calls) ----
let paused = false; // mirrors PAUSE_SWITCH; updated from state_changed + read at boot
const pendingConfirm = new Map<string, { domain: string; service: string; data: Record<string, unknown> }>();
let confirmSeq = 1;

const confirmSig = (domain: string, service: string, data: Record<string, unknown>) =>
  `${domain}.${service}:${[data?.entity_id].flat().filter(Boolean).join(",")}`;
function requestConfirm(domain: string, service: string, data: Record<string, unknown>, reason: string): string {
  const human = `${domain}.${service}${data?.entity_id ? ` on ${[data.entity_id].flat().join(", ")}` : ""}`;
  // Dedupe: if the agent re-asks for the same action in a later step, don't spawn another Yes/No.
  const sig = confirmSig(domain, service, data);
  for (const p of pendingConfirm.values()) if (confirmSig(p.domain, p.service, p.data) === sig)
    return `Already asked the user to confirm ${human} — still waiting on their Yes/No. Don't ask again.`;
  const id = `c${confirmSeq++}`;
  pendingConfirm.set(id, { domain, service, data });
  for (const tgt of cfg.notifyTargets)
    ha.notify(tgt, "Cooper — confirm?", reason || `Confirm: ${human}?`, {
      importance: "high", priority: "high", ttl: 0, tag: `cooper-${id}`,
      actions: [{ action: `COOPER_OK_${id}`, title: "Yes, do it" }, { action: `COOPER_NO_${id}`, title: "No" }],
    }).catch(() => {});
  log(`${C.yellow}⚠ confirmation requested #${id}: ${human}${C.reset}`);
  setTimeout(() => { if (pendingConfirm.delete(id)) log(`${C.gray}confirm #${id} expired (no reply)${C.reset}`); }, 300_000);
  return `Asked the user to confirm on their phone (Yes/No): ${human}. Say you've requested confirmation — it runs only if they tap Yes.`;
}

// React to the Yes/No tap from the mobile app.
ha.onEvent("mobile_app_notification_action", async (d) => {
  const m = String(d.action || "").match(/^COOPER_(OK|NO)_(c\d+)$/);
  if (!m) return;
  const [, verb, id] = m;
  const p = pendingConfirm.get(id); if (!p) return;
  pendingConfirm.delete(id);
  if (verb === "NO") { log(`${C.gray}✗ #${id} denied${C.reset}`); notifyAll(`Okay — skipped ${p.domain}.${p.service}.`); return; }
  if (paused) { notifyAll(`Can't run that — Cooper is paused.`); return; }
  log(`${C.green}✓ #${id} approved → ${p.domain}.${p.service}${C.reset}`);
  store.logAction(Date.now(), null, "confirm:execute", `${p.domain}.${p.service} ${JSON.stringify(p.data)}`);
  try { await ha.callService(p.domain, p.service, p.data); notifyAll(`Done — ${p.domain}.${p.service}.`); }
  catch (e) { notifyAll(`Couldn't do ${p.domain}.${p.service}: ${e}`); }
});

const hooks: Hooks = { paused: () => paused, requestConfirm };

// Self-provision the voice bridge on first run, so setup is one paste (the routing prompt), not a
// manual helper + script + exposure. Idempotent: only creates what's missing.
const ASK_COOPER_SCRIPT = {
  alias: "Ask Cooper",
  description: "Hand ANY request to the Cooper guardian agent — watching/monitoring, presence simulation, scheduling timed sequences, camera checks, or multi-step tasks. Cooper runs it and notifies the result. Use for anything beyond simple one-shot device control or direct questions.",
  fields: { goal: { description: "The full request, in plain language", required: true, selector: { text: {} } } },
  mode: "queued",
  sequence: [{ action: "input_text.set_value", target: { entity_id: WATCH_REQUEST }, data: { value: "{{ goal }}" } }],
};
async function provisionBridge() {
  try {
    const states = await ha.getStates();
    const has = (id: string) => states.some((s) => s.entity_id === id);
    if (!has(WATCH_REQUEST)) { await ha.wsCall({ type: "input_text/create", name: "Cooper Watch Request", max: 255 }); log(`${C.green}✓ created ${WATCH_REQUEST}${C.reset}`); }
    if (!has("script.cooper_watch")) { await ha.postConfig("/config/script/config/cooper_watch", ASK_COOPER_SCRIPT); log(`${C.green}✓ created script.cooper_watch (Ask Cooper)${C.reset}`); }
    if (!has(PAUSE_SWITCH)) { await ha.wsCall({ type: "input_boolean/create", name: "Cooper Pause" }); log(`${C.green}✓ created ${PAUSE_SWITCH} (kill-switch)${C.reset}`); }
    await ha.wsCall({ type: "homeassistant/expose_entity", assistants: ["conversation"], entity_ids: ["script.cooper_watch"], should_expose: true }).catch(() => {});
    const sw = (await ha.getStates()).find((s) => s.entity_id === PAUSE_SWITCH); // sync initial kill-switch state
    paused = sw?.state === "on";
    if (paused) log(`${C.yellow}⏸ Cooper is PAUSED (kill-switch on) — device actions held${C.reset}`);
  } catch (e) { log(`${C.yellow}bridge provision skipped: ${e}${C.reset}`); }
}
provisionBridge();

ha.subscribe((entityId, st) => {
  // Kill-switch: keep `paused` in sync with the toggle (instant, no LLM).
  if (entityId === PAUSE_SWITCH) { paused = st.state === "on"; log(`${paused ? C.yellow + "⏸ PAUSED — actions held" : C.green + "▶ resumed — actions allowed"}${C.reset}`); return; }
  // Bridge: the phone/voice assistant forwards ANY request into this helper. Cooper runs it (watch,
  // do, schedule, answer) and notifies the result back — the phone is a thin mic for the guardian.
  if (entityId === WATCH_REQUEST && st.state && st.state.trim()) {
    const text = st.state.trim();
    const tnow = Date.now();
    ha.callService("input_text", "set_value", { entity_id: WATCH_REQUEST, value: "" }).catch(() => {}); // clear early
    const isWatch = wantsStandingWhileAway(text) || wantsPresenceStandDown(text) || WATCH_INTENT.test(text);
    if (isWatch) {
      const g = store.addGoal(text, tnow, tnow, parseExpiry(text, tnow), wantsPresenceStandDown(text), wantsStandingWhileAway(text));
      goals.push(g);
      header(`📥 watch from phone: "${text}" (#${g.id})${g.expires ? ` [until ${new Date(g.expires).toISOString()}]` : ""}${g.untilPresent ? " [until home]" : ""}${g.whileAway ? " [standing while-away]" : ""}`);
      store.logAction(g.created, g.id, "watch:create", `bridge: ${text}`);
      if (g.whileAway) { checkPresenceStandDown(tnow).catch(() => {}); notifyAll(`Standing watch set: "${text}". I'll arm whenever everyone's out.`); }
      else runGoal(cfg, ha, text, "(initial check — establish what's normal)", budget, hooks)
        .then((r) => { log(`   ${C.green}→ ${r}${C.reset}`); notifyAll(r); }).catch((e) => log(`   ${C.red}intake error: ${e}${C.reset}`));
    } else {
      // Any non-watch request → run it now (control / schedule / answer) and report the result back.
      header(`📥 request from phone: "${text}"`);
      store.logAction(tnow, null, "bridge:do", text);
      runGoal(cfg, ha, text, "(handed over from the voice assistant — handle it now; the summary is reported back to the user)", budget, hooks)
        .then((r) => { log(`   ${C.green}→ ${r}${C.reset}`); notifyAll(r); }).catch((e) => log(`   ${C.red}bridge error: ${e}${C.reset}`));
    }
    return;
  }
  // Presence change → fire arrival tasks + check away-watch stand-down (deterministic, no LLM).
  if (entityId.startsWith("person.")) {
    if (st.state === "home" && tasks.some((t) => t.onArrival)) fireArrivalTasks(Date.now());
    checkPresenceStandDown(Date.now()).catch(() => {});
  }
  if (!goals.some((g) => g.type === "watch")) return;
  if (!interesting(entityId, st)) return;
  buffer.push(`${new Date().toISOString()}  ${entityId} -> ${st.state}`);
  if (timer) clearTimeout(timer);
  timer = setTimeout(processBuffer, 3000); // debounce: settle 3s after the last event
});

// Remove a goal everywhere and tell the user why.
function standDown(g: Goal, now: number, kind: string, msg: string) {
  goals.splice(goals.indexOf(g), 1); store.deleteGoal(g.id);
  store.logAction(now, g.id, kind, g.text);
  log(`${C.yellow}🕛 stood down #${g.id} (${kind}): "${g.text}"${C.reset}`);
  for (const tgt of cfg.notifyTargets) ha.notify(tgt, "Cooper", msg).catch(() => {});
}

// Stand down any time-boxed goals whose window has passed (e.g. "watch until Monday evening").
function reapExpired(now: number) {
  for (const g of goals.filter((x) => x.expires && now >= x.expires))
    standDown(g, now, "watch:expired", `Done watching: "${g.text}" — the window ended, standing down.`);
}

// Away-watches stand down once everyone is home again — but only after someone has actually been
// away (so arming it while everyone's home doesn't instantly cancel). Time cap is the fallback.
async function checkPresenceStandDown(now: number) {
  const pg = goals.filter((g) => g.untilPresent || g.whileAway);
  if (!pg.length) return;
  const persons = await ha.persons();
  if (!persons.length) return; // no presence entities → rely on the time cap
  const anyAway = persons.some((p) => p.state !== "home");
  const allHome = persons.every((p) => p.state === "home");
  for (const g of pg) {
    // One-shot away-watch: stand down (delete) when everyone's home, once someone's been away.
    if (g.untilPresent) {
      if (anyAway && !g.sawAway) { g.sawAway = true; store.setSawAway(g.id); log(`${C.gray}#${g.id}: occupants away — presence stand-down armed${C.reset}`); }
      if (g.sawAway && allHome) standDown(g, now, "watch:home", `Welcome home — standing down from "${g.text}".`);
    }
    // Standing while-away watch: arm when everyone's out, disarm (but keep) when someone returns.
    if (g.whileAway) {
      const isArmed = armed.get(g.id) ?? false;
      if (!isArmed && !allHome && anyAway) {
        armed.set(g.id, true);
        header(`🛡 ARMED standing watch #${g.id} — everyone's out: "${g.text}"`);
        store.logAction(now, g.id, "watch:armed", g.text);
        if (budget.canRun(now).ok) runGoal(cfg, ha, g.text, "(now arming — everyone is out; establish what's normal)", budget, hooks)
          .then((r) => log(`   ${C.green}→ ${r}${C.reset}`)).catch(() => {});
      } else if (isArmed && allHome) {
        armed.set(g.id, false);
        log(`${C.yellow}🏠 disarmed standing watch #${g.id} — someone's home${C.reset}`);
        store.logAction(now, g.id, "watch:disarmed", g.text);
        for (const tgt of cfg.notifyTargets) ha.notify(tgt, "Cooper", `Welcome home — I'll stop watching and re-arm next time you're all out.`).catch(() => {});
      }
    }
  }
}

// Fire a deferred task exactly once: remove it up front (so it can't re-fire), then run it.
async function fireTask(tk: Task, now: number, reason: string) {
  if (firing.has(tk.id)) return;
  firing.add(tk.id);
  const i = tasks.indexOf(tk); if (i >= 0) tasks.splice(i, 1);
  store.deleteTask(tk.id);
  header(`🏠 TASK fire #${tk.id} (${reason}): "${tk.text}"`);
  try { const r = await runGoal(cfg, ha, tk.text, `(deferred task — ${reason})`, budget, hooks); store.logAction(now, null, "task:fire", String(r).slice(0, 500)); log(`   ${C.green}→ ${r}${C.reset}`); }
  catch (e) { log(`   ${C.red}task #${tk.id} error: ${e}${C.reset}`); }
  finally { firing.delete(tk.id); }
}

const fireDueTimeTasks = (now: number) => { for (const tk of tasks.filter((t) => t.runAt && now >= t.runAt)) fireTask(tk, now, "scheduled time"); };
const fireArrivalTasks = (now: number) => { for (const tk of tasks.filter((t) => t.onArrival)) fireTask(tk, now, "arrived home"); };
setInterval(() => fireDueTimeTasks(Date.now()), 30_000); // catches scheduled + any missed during downtime
setTimeout(() => checkPresenceStandDown(Date.now()).catch(() => {}), 3000); // arm standing watches if already out

async function processBuffer() {
  const events = buffer; buffer = []; timer = null;
  const now = Date.now();
  reapExpired(now); await checkPresenceStandDown(now);
  const ctx = `Recent home events:\n${events.join("\n")}`;
  const gate = budget.canRun(now);
  if (!gate.ok) { log(`${C.yellow}💸 skip watch eval — ${gate.reason}${C.reset}`); return; } // cost cap: pause auto evals
  for (const g of goals.filter((x) => x.type === "watch" && now - x.lastRun > COOLDOWN_MS && (!x.whileAway || armed.get(x.id)))) {
    if (!budget.canRun(now).ok) break;
    g.lastRun = now; store.touchGoal(g.id, now);
    header(`👁 WATCH eval #${g.id} (${events.length} event(s))`);
    try { const r = await runGoal(cfg, ha, g.text, ctx, budget, hooks); store.logAction(now, g.id, "watch:eval", String(r).slice(0, 500)); log(`   ${C.green}→ ${r}${C.reset}`); }
    catch (e) { log(`   ${C.red}watch goal #${g.id} error: ${e}${C.reset}`); }
  }
}

// ---- Heartbeat: periodic safety re-check of watch-goals (in case events were missed) ----
setInterval(async () => {
  const now = Date.now();
  reapExpired(now); await checkPresenceStandDown(now);
  for (const g of goals.filter((x) => x.type === "watch" && now - x.lastRun > COOLDOWN_MS && (!x.whileAway || armed.get(x.id)))) {
    if (!budget.canRun(now).ok) { log(`${C.yellow}💸 skip heartbeat — ${budget.canRun(now).reason}${C.reset}`); break; }
    g.lastRun = now; store.touchGoal(g.id, now);
    header(`⏱ HEARTBEAT eval #${g.id}`);
    try { const r = await runGoal(cfg, ha, g.text, "(periodic check — no specific event)", budget, hooks); store.logAction(now, g.id, "watch:heartbeat", String(r).slice(0, 500)); log(`   ${C.green}→ ${r}${C.reset}`); }
    catch (e) { log(`   ${C.red}heartbeat goal #${g.id} error: ${e}${C.reset}`); }
  }
}, Math.max(60, cfg.heartbeatSeconds) * 1000);

// ---- Morning briefing: once a day at cfg.briefingTime (local HH:MM), a proactive do-goal ----
const BRIEFING_GOAL =
  "Morning briefing. In a few friendly sentences: today's weather (use web search), my calendar " +
  "and when I should leave for the first event, anything notable from overnight home/camera/door " +
  "events, and anything that needs attention (open doors, low batteries, offline devices). Then " +
  "notify me with the summary. Be concise.";
let lastBriefing = "";
if (cfg.briefingTime) setInterval(async () => {
  const d = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  if (hhmm !== cfg.briefingTime || lastBriefing === today) return;
  lastBriefing = today;
  if (!budget.canRun(Date.now()).ok) { log(`${C.yellow}💸 skip briefing — budget cap${C.reset}`); return; }
  header(`📰 MORNING BRIEFING (${cfg.briefingTime})`);
  try { const r = await runGoal(cfg, ha, BRIEFING_GOAL, "(scheduled morning briefing)", budget, hooks); store.logAction(Date.now(), null, "briefing", String(r).slice(0, 500)); log(`   ${C.green}→ ${r}${C.reset}`); }
  catch (e) { log(`   ${C.red}briefing error: ${e}${C.reset}`); }
}, 60_000);
