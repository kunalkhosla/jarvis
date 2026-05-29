import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { HaClient } from "./ha.js";
import { runGoal } from "./agent.js";

const cfg = loadConfig();
const ha = new HaClient(cfg);

// In-memory goal store for v0 (TODO: persist to SQLite — goals, baselines, action log).
interface Goal { id: number; text: string; created: number; }
const goals: Goal[] = [];
let nextId = 1;

console.log(`[jarvis] starting — model=${cfg.model}, observe=${cfg.observeMode}, search=${cfg.searchProvider}`);

// HTTP control surface: /healthz, and POST /goal {text} to run a do-goal now (returns the summary).
createServer(async (req, res) => {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/healthz") return json(200, { ok: true, observe: cfg.observeMode, goals: goals.length });
  if (req.method === "POST" && req.url === "/goal") {
    let raw = ""; for await (const c of req) raw += c;
    const { text } = JSON.parse(raw || "{}");
    if (!text) return json(400, { error: "text required" });
    const goal: Goal = { id: nextId++, text, created: Date.now() };
    goals.push(goal);
    try { return json(200, { id: goal.id, result: await runGoal(cfg, ha, text) }); }
    catch (e) { return json(500, { error: String(e) }); }
  }
  json(404, { error: "not found" });
}).listen(8099, () => console.log("[jarvis] http on :8099"));

// Watch-goal engine (skeleton): react to live state changes + a heartbeat.
// TODO: per-goal baselines, debounce/cooldown, only re-run relevant goals on relevant events.
ha.subscribe((entityId) => {
  // For now just observe; wire watch-goals here (e.g. motion/door while a "keep an eye" goal is active).
  if (goals.length === 0) return;
  // console.log(`[jarvis] event ${entityId}`);
});

setInterval(async () => {
  for (const g of goals) {
    try { console.log(`[jarvis] heartbeat goal #${g.id}: ${await runGoal(cfg, ha, g.text)}`); }
    catch (e) { console.error(`[jarvis] goal #${g.id} error`, e); }
  }
}, Math.max(60, cfg.heartbeatSeconds) * 1000);
