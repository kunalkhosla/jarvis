import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { HaClient } from "./ha.js";
import { runGoal, Hooks } from "./agent.js";
import { Store } from "./store.js";
import { Budget } from "./budget.js";
import { C, L as log, header } from "./log.js";

const cfg = loadConfig();
const ha = new HaClient(cfg);
const budget = new Budget(cfg.maxLlmCallsPerHour, cfg.maxLlmCallsPerDay);
const store = new Store(); // v2 keeps the store ONLY for the action/audit log — HA owns all durable behavior.

const PAUSE_SWITCH = "input_boolean.cooper_pause"; // kill-switch: ON = halt all device actions
let paused = false; // mirrors PAUSE_SWITCH; refreshed per turn (no event firehose in v2)
const notifyAll = (msg: string) => { for (const tgt of cfg.notifyTargets) ha.notify(tgt, "Cooper", msg).catch(() => {}); };

log(`${C.bold}${C.green}Cooper Guardian (v2 routing agent) starting${C.reset} — model=${cfg.model}, observe=${cfg.observeMode}, caps=${cfg.maxLlmCallsPerHour}/hr ${cfg.maxLlmCallsPerDay}/day`);

// ---- HTTP control surface: /healthz + POST /ask ----
// v2 is a pure router: the conversation integration POSTs each turn to /ask, and the HA automations
// Cooper authors call it back the same way (via conversation.process → conversation.cooper → /ask).
// No /goal endpoint, no event subscription, no polling — durable behavior lives in HA itself.
createServer(async (req, res) => {
  const json = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    if (req.url === "/healthz")
      return json(200, { ok: true, observe: cfg.observeMode, paused, budget: budget.stats(Date.now()) });
    if (req.method === "POST" && req.url === "/ask") {
      let raw = ""; for await (const c of req) raw += c;
      let body: any;
      try { body = JSON.parse(raw || "{}"); } catch { return json(400, { error: "invalid JSON" }); }
      const { text, history, session_id, device_id, user_id, stream } = body;
      if (!text || typeof text !== "string") return json(400, { error: "text (string) required" });
      const hist = Array.isArray(history) ? history : undefined;
      const sid = typeof session_id === "string" ? session_id : undefined;
      const did = typeof device_id === "string" ? device_id : undefined;
      const uid = typeof user_id === "string" ? user_id : undefined;
      // Streaming mode (NDJSON): emit a {type:"step"} line per agent step as it runs, then a final
      // {type:"final"} with the reply — so the integration can feed running feedback to HA's voice
      // pipeline instead of one slow blob. Non-stream callers get the plain {reply} JSON as before.
      if (stream === true) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const send = (obj: unknown) => { try { res.write(JSON.stringify(obj) + "\n"); } catch { /* client gone */ } };
        try {
          // onProgress emits content chunks (token deltas as Cooper types, plus the odd status line) —
          // the integration concatenates them into the spoken response. `final` is for history only.
          const reply = await handleUtterance(text.trim(), hist, sid, did, uid, (t) => send({ type: "chunk", text: t }));
          send({ type: "final", reply });
        } catch (e) { send({ type: "final", reply: `Sorry — I hit an error: ${String(e).slice(0, 200)}` }); }
        return res.end();
      }
      try {
        const reply = await handleUtterance(text.trim(), hist, sid, did, uid);
        return json(200, { reply });
      } catch (e) { return json(500, { error: String(e) }); }
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

// ---- Push Yes/No confirmation (AUTONOMOUS path: a judge callback with no open conversation) ----
// When a confirm-tier action arises with no conversation session, we push a Yes/No to the phone and
// run it only on the tap. (During a conversation we ask in-chat instead — see requestSessionConfirm.)
const pendingConfirm = new Map<string, { domain: string; service: string; data: Record<string, unknown> }>();
let confirmSeq = 1;
const MAX_PENDING_CONFIRMS = 3; // never fan out more than this many Yes/No prompts at once (anti-spam)
const confirmSig = (domain: string, service: string, data: Record<string, unknown>) =>
  `${domain}.${service}:${[data?.entity_id].flat().filter(Boolean).join(",")}`;

function requestConfirm(domain: string, service: string, data: Record<string, unknown>, reason: string): string {
  const human = `${domain}.${service}${data?.entity_id ? ` on ${[data.entity_id].flat().join(", ")}` : ""}`;
  const sig = confirmSig(domain, service, data);
  for (const p of pendingConfirm.values()) if (confirmSig(p.domain, p.service, p.data) === sig)
    return `Already asked the user to confirm ${human} — still waiting on their Yes/No. Don't ask again.`;
  if (pendingConfirm.size >= MAX_PENDING_CONFIRMS)
    return `Too many actions already awaiting confirmation (${pendingConfirm.size}). NOT sending another prompt — do the reversible parts automatically, or ask once to confirm the batch as a whole.`;
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
  await refreshPaused();
  if (paused) { notifyAll(`Can't run that — Cooper is paused.`); return; }
  if (cfg.observeMode) { log(`${C.gray}[observe] #${id} approved but not acting: ${p.domain}.${p.service}${C.reset}`); notifyAll(`Observe mode is on — I didn't actually do ${p.domain}.${p.service}.`); return; }
  log(`${C.green}✓ #${id} approved → ${p.domain}.${p.service}${C.reset}`);
  store.logAction(Date.now(), null, "confirm:execute", `${p.domain}.${p.service} ${JSON.stringify(p.data)}`);
  try {
    await ha.callService(p.domain, p.service, p.data);
    const v = await ha.verifyServiceEffect(p.service, p.data); // confirm it actually took effect
    notifyAll(v.ok ? `Done — ${p.domain}.${p.service}.` : `Tried ${p.domain}.${p.service} but it didn't take — ${v.detail}.`);
  }
  catch (e) { notifyAll(`Couldn't do ${p.domain}.${p.service}: ${e}`); }
});

// ---- In-chat Yes/No confirmation (CONVERSATION path) ----
// A confirm-tier action during a conversation turn isn't pushed — we ask the user in the reply and
// resolve it on their NEXT turn. Keyed by session (conversation_id).
const pendingSessionConfirm = new Map<string, { actions: { domain: string; service: string; data: Record<string, unknown> }[]; ts: number }>();
const SESSION_CONFIRM_TTL = 300_000;
const AFFIRM = /^\s*(y|ya|yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|confirm|confirmed|please do|affirmative)\b/i;
const NEGATIVE = /^\s*(n|no|nope|nah|cancel|stop|don'?t|negative|never\s?mind|skip|leave it)\b/i;

function requestSessionConfirm(session: string, domain: string, service: string, data: Record<string, unknown>, _reason: string): string {
  const human = `${domain}.${service}${data?.entity_id ? ` on ${[data.entity_id].flat().join(", ")}` : ""}`;
  const cur = pendingSessionConfirm.get(session) ?? { actions: [], ts: Date.now() };
  const sig = confirmSig(domain, service, data);
  if (!cur.actions.some((a) => confirmSig(a.domain, a.service, a.data) === sig)) cur.actions.push({ domain, service, data });
  cur.ts = Date.now();
  pendingSessionConfirm.set(session, cur);
  log(`${C.yellow}⚠ in-chat confirm queued [${session.slice(0, 8)}]: ${human}${C.reset}`);
  return `Confirmation needed for ${human}. In your reply, ASK the user to confirm with a short yes/no question (e.g. "Unlock the front door — yes or no?"). Do NOT claim it's done; it runs only if they say yes on their next turn.`;
}

// Autonomous hooks (no conversation session): kill-switch + push confirm.
const hooks: Hooks = { paused: () => paused, requestConfirm };

// ---- Single entrypoint for an utterance (conversation turn OR an automation's judge callback) ----
// Slugify like HA does (lowercase, non-alphanumeric → underscore) so we can derive a device's
// companion-app notify service (notify.mobile_app_<slug>) from its name.
const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Resolve WHO/WHERE a turn came from into a context line: the caller's own phone (so "ping me"
 *  targets it, no guessing) and their name. Best-effort — empty string if nothing resolves. */
async function callerContext(deviceId?: string, userId?: string): Promise<string> {
  const bits: string[] = [];
  try {
    if (deviceId) {
      const name = (await ha.template(`{{ device_attr('${deviceId}','name_by_user') or device_attr('${deviceId}','name') or '' }}`)).trim();
      if (name) {
        const svc = `notify.mobile_app_${slugify(name)}`;
        if ((await ha.services()).has(svc))
          bits.push(`They're talking to you from "${name}". When they ask you to notify / ping / text / alert THEM — right now or inside an automation you author — use ${svc} (their own phone). Don't guess a different target.`);
        else bits.push(`They're talking to you from the device "${name}".`);
      }
    }
    if (userId) {
      const person = (await ha.template(`{{ states.person | selectattr('attributes.user_id','eq','${userId}') | map(attribute='name') | join(', ') }}`)).trim();
      if (person) bits.push(`The person speaking is ${person}.`);
    }
  } catch { /* best effort */ }
  return bits.length ? `\n\nCALLER: ${bits.join(" ")}` : "";
}

export interface Turn { role: string; text: string }
async function handleUtterance(text: string, history?: Turn[], session?: string, deviceId?: string, userId?: string, onProgress?: (text: string) => void): Promise<string> {
  const tnow = Date.now();
  await refreshPaused(); // keep the kill-switch fresh per turn (v2 has no state_changed subscription)
  reapDeadAutomations().catch(() => {}); // opportunistic cleanup of provably-dead [Cooper] rules (throttled)

  // In-chat confirmation: if this session asked a yes/no last turn, resolve it before anything else.
  if (session) {
    const pend = pendingSessionConfirm.get(session);
    if (pend && tnow - pend.ts < SESSION_CONFIRM_TTL) {
      if (AFFIRM.test(text)) {
        pendingSessionConfirm.delete(session);
        if (paused) return "Can't do that — Cooper is paused (kill-switch on).";
        if (cfg.observeMode) {
          const would = pend.actions.map((a) => `${a.domain}.${a.service}${a.data?.entity_id ? ` on ${[a.data.entity_id].flat().join(", ")}` : ""}`).join(", ");
          log(`${C.gray}[observe] in-chat confirm approved but not acting: ${would}${C.reset}`);
          return `Observe mode is on, so I didn't actually do it — but I would: ${would}.`;
        }
        const done: string[] = []; const failed: string[] = [];
        for (const a of pend.actions) {
          try {
            await ha.callService(a.domain, a.service, a.data);
            store.logAction(tnow, null, "confirm:execute", `${a.domain}.${a.service} ${JSON.stringify(a.data)}`);
            // Read the entity back — a 200 doesn't mean the device obeyed. Only report success if it did.
            const v = await ha.verifyServiceEffect(a.service, a.data);
            if (v.ok) done.push(`${a.domain}.${a.service}`);
            else failed.push(`${a.domain}.${a.service} — didn't take (${v.detail})`);
          }
          catch (e) { failed.push(`${a.domain}.${a.service} (${String(e).slice(0, 80)})`); }
        }
        log(`${C.green}✓ in-chat confirm executed: ${done.join(", ") || "none"}${failed.length ? ` | failed: ${failed.join(", ")}` : ""}${C.reset}`);
        return failed.length ? `Done: ${done.join(", ")}. Couldn't: ${failed.join(", ")}.` : `Done — ${done.join(", ")}.`;
      }
      if (NEGATIVE.test(text)) { pendingSessionConfirm.delete(session); log(`${C.gray}✗ in-chat confirm declined [${session.slice(0, 8)}]${C.reset}`); return "Okay — skipped it."; }
      pendingSessionConfirm.delete(session); // neither yes nor no → user moved on; drop the stale confirm and handle the new request
    } else if (pend) pendingSessionConfirm.delete(session); // expired
  }

  // Confirm-tier actions ask in-chat during a conversation; the autonomous path pushes (see hooks).
  const askHooks: Hooks = session
    ? { paused: () => paused, requestConfirm: (d, s, data, reason) => requestSessionConfirm(session, d, s, data, reason) }
    : hooks;
  const histCtx = history && history.length
    ? `\n\nRecent conversation (for context / pronoun resolution — newest last):\n${history.map((h) => `${h.role}: ${h.text}`).join("\n")}`
    : "";

  // Management context: show Cooper its OWN [Cooper] automations/scripts so it can manage them by
  // natural language — "nevermind, I got the package" / "stop that" → delete_automation/delete_script,
  // and reuse an id to edit one.
  let mgmtCtx = "";
  try {
    // One state fetch, filtered to Cooper's own automations + scripts (id cooper_* / alias [Cooper]).
    const states = await ha.getStates();
    const mine = (prefix: string) => states
      .filter((s) => s.entity_id.startsWith(prefix))
      .map((s) => ({ id: (s.attributes?.id as string | undefined) ?? s.entity_id.split(".")[1], alias: (s.attributes?.friendly_name as string) ?? s.entity_id, state: s.state, kind: prefix.slice(0, -1) }))
      .filter((x) => x.id.startsWith("cooper_") || x.alias.startsWith("[Cooper]"));
    const lines = [...mine("automation."), ...mine("script.")].map((x) => `${x.kind} id=${x.id} "${x.alias}" (${x.state})`);
    if (lines.length) mgmtCtx = `\n\nYour active [Cooper] automations/scripts — if the user implies one is no longer needed ("nevermind", "I got the package", "they're here", "stop that"), delete it; reuse the id to edit:\n${lines.join("\n")}`;
  } catch { /* management context is best-effort */ }

  const callerCtx = await callerContext(deviceId, userId);

  header(`📥 request: "${text}"`);
  store.logAction(tnow, null, "ask:do", text);
  try {
    return await runGoal(cfg, ha, text, `(handle this now; reply in one or two short sentences the assistant can speak aloud)${callerCtx}${mgmtCtx}${histCtx}`, budget, askHooks, onProgress);
  } catch (e) { log(`   ${C.red}request error: ${e}${C.reset}`); return `Sorry — I hit an error: ${e}`; }
}

// ---- Dead-rule reaper ----
// Cooper's one-shot rules ("today"/"tonight"/"N times") carry a date condition; once that date passes
// the rule can NEVER fire again but lingers forever. Sweep them on interaction (throttled, no background
// loop): delete [Cooper] automations whose top-level date condition is provably in the past — zero false
// positives (it literally cannot fire), so it's safe to remove without asking.
let lastReap = 0;
async function reapDeadAutomations(): Promise<void> {
  const now = Date.now();
  if (now - lastReap < 3_600_000) return; // at most hourly
  lastReap = now;
  try {
    const states = await ha.getStates();
    // STRICT: only ever reap genuine Cooper automations — require BOTH markers Cooper always sets
    // together (config id cooper_* AND alias [Cooper] …). Never touch a user's own automation.
    const mine = states.filter((s) => s.entity_id.startsWith("automation.") && String(s.attributes?.id ?? "").startsWith("cooper_") && String(s.attributes?.friendly_name ?? "").startsWith("[Cooper]"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ || "UTC" }); // YYYY-MM-DD local
    for (const a of mine) {
      const id = String(a.attributes?.id ?? ""); if (!id) continue;
      let txt: string;
      try { txt = JSON.stringify(await ha.getAutomationConfig(id)); } catch { continue; }
      if (/"condition"\s*:\s*"or"/.test(txt)) continue; // OR logic: a past date may not mean dead — skip
      const dates = [...txt.matchAll(/strftime\('%Y-%m-%d'\)\s*==\s*'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
      if (dates.length && dates.every((d) => d < today)) {
        try { await ha.deleteAutomation(id); log(`${C.gray}🧹 reaped dead [Cooper] automation ${id} (${dates.join(",")} < ${today})${C.reset}`); } catch { /* */ }
      }
    }
  } catch { /* best effort */ }
}

// ---- Kill-switch ----
/** Refresh `paused` from the single kill-switch entity (cheap; no full state dump, no subscription). */
async function refreshPaused(): Promise<void> {
  const st = await ha.getState(PAUSE_SWITCH);
  if (st) paused = st.state === "on";
}

// Render log timestamps in the home's local time: adopt HA's configured timezone as the process TZ
// (the Supervisor usually already does this for add-ons; this makes it reliable standalone too).
async function adoptHomeTimezone() {
  try {
    const tz = (await ha.config()).time_zone as string | undefined;
    if (tz && tz !== process.env.TZ) { process.env.TZ = tz; log(`${C.gray}log timezone → ${tz}${C.reset}`); }
  } catch { /* keep container default */ }
}
adoptHomeTimezone();

// Self-provision the kill-switch (input_boolean.cooper_pause) on first run and sync `paused`.
async function provisionKillSwitch() {
  try {
    const states = await ha.getStates();
    if (!states.some((s) => s.entity_id === PAUSE_SWITCH)) {
      await ha.wsCall({ type: "input_boolean/create", name: "Cooper Pause" });
      log(`${C.green}✓ created ${PAUSE_SWITCH} (kill-switch)${C.reset}`);
    }
    await refreshPaused();
    if (paused) log(`${C.yellow}⏸ Cooper is PAUSED (kill-switch on) — device actions held${C.reset}`);
  } catch (e) { log(`${C.yellow}kill-switch provision skipped: ${e}${C.reset}`); }
}
provisionKillSwitch();
