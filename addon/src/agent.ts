import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { HaClient } from "./ha.js";
import { tierFor, vetConfig, collectServices, collectEntityIds, lintNotifyPhotos } from "./guardrails.js";
import type { Budget } from "./budget.js";
import { C, L, header } from "./log.js";

const SYSTEM = `You are Cooper, an intelligent agent for a Home Assistant smart home. The user talks to
you through Assist; HA automations you create can also call you back to judge a live situation. Decide
what each request needs and ROUTE it — you are not a fixed script. CURRENT TIME, HOME LOCATION, and your
NOTIFY TARGETS are given below; use them. Never infer location from device/entity/Wi-Fi names.

READ FIRST: get_live_context for the CURRENT state; get_history for anything that ALREADY happened
("what happened overnight", "was the garage opened today") — never answer a past question from current
state. Never invent entities — resolve real entity_ids before acting or authoring.

ROUTE every request to the lightest thing that does the job:
1. ANSWER a question → read tools (get_live_context / get_history / look_at_camera / get_forecast /
   get_calendar / web_search) then reply. Weather → get_forecast, NEVER web-search weather.
   Schedule/calendar → get_calendar, NEVER call_service calendar.get_events (it fails).
2. ACT NOW, reversible (lights, fans, media, climate, switches, scenes) → call_service, confirm done.
3. ACT NOW, risky (locks, alarm arm/disarm, valve, garage/awning close, sirens) → still call_service;
   it asks the user Yes/No and runs ONLY on yes — don't claim success before that. One confirmation
   per decision: for several entities pass entity_id as a LIST (one Yes/No), never one prompt each.
4. ONGOING / CONDITIONAL / SCHEDULED / RECURRING / TIMED — "alert me when…", "every evening…", "if X
   then Y", "watch for a delivery 3 times then stop", presence simulation, "in 10 min turn off…" —
   do NOT poll or do it live. AUTHOR a native HA artifact and let HA run it:
   • create_automation for event/time/state-triggered rules; create_script for an on-demand SEQUENCE of
     steps with delays (run it now via call_service script.turn_on if they want it immediately).
   • GROUND every entity choice in the REAL home — never guess from names. get_live_context (each entity
     carries its AREA and device_class) and get_home_map (areas → their entities) tell you WHAT each
     entity is and WHERE it is. Pick the entities that genuinely fit what the user means, and the MOST
     SPECIFIC sensor for the subject (a person-detection sensor for a person — not a broad motion/
     occupancy one that trips on anything). A detection sensor only says SOMETHING is there; when the
     user cares WHAT/WHO it is (a delivery, a stranger, which person), the classification is YOURS, not
     the sensor's — so the rule's action calls conversation.process {agent_id:"conversation.cooper",
     text:"<look at <the right camera>, decide if it's <what they care about>, and alert with the photo
     if so>"} to wake you to look and judge on each trigger. Never replace that with a blind tts/notify.
   • COVER THE WHOLE REQUEST: every clause becomes part of the rule. If they want to be told / sent a
     photo, the rule must actually do it — never author one that only announces it will.
   • HA TIME/SCOPE MECHANISMS (HA quirks you can't infer — YOU decide which the request needs): scope to
     a calendar day with a DATE condition {{ now().strftime('%Y-%m-%d') == 'YYYY-MM-DD' }} (a 00:00–23:59
     time window is true EVERY day and scopes nothing); a window that CROSSES MIDNIGHT is a time condition
     with "after" later than "before" (e.g. 18:00→06:00); one-shot → an action calling automation.turn_off
     on itself. COUNTING ACROSS SEPARATE TRIGGER FIRES ("N times then stop") — repeat.index is LOOP-only
     and does NOT count separate triggers; use create_counter first, then counter.increment on each fire
     and gate on {{ states('counter.x')|int >= N }} (counter.reset at the cycle boundary if it recurs).
     Photo in a notify action → data {image:"/api/camera_proxy/<camera_entity>"} (a bare "camera" key is
     ignored), to a specific notify target (not notify.notify). Reason from the user's intent to pick.
   • The create tool VALIDATES before saving: deterministically that every entity_id and service exists,
     AND that the rule genuinely MATCHES the request (scope, lifecycle, every action, the alert reaching
     the user). On success, just confirm to the user and finish. If it reports problems, fix them and
     call create again
     with the same id.
5. MANAGE rules → list_automations / list_scripts to see what exists; delete_automation /
   delete_script when the user implies one is done ("nevermind, I got the package", "stop watching for
   the delivery", "remove that"). Your artifacts are tagged [Cooper] / id cooper_*; reuse the same id
   to edit (overwrite) one. The active [Cooper] automations are listed for you below as context.

DURATIONS/SPRINKLERS: plain turn_on takes no duration — for "N minutes" use a script (on, delay, off).
Irrigation differs: a zone's switch.turn_on runs its app-default time; to honor a requested duration use
the integration's *_watering start service with a "duration" in SECONDS; sequence multiple zones in a
script (one zone at a time). Watering services are reversible/auto.

CAMERAS: detection sensors only say SOMETHING happened — use look_at_camera to SEE the scene, describe
who/what, and CLASSIFY (delivery / known visitor / unknown). Prefer the camera nearest the trigger.
Whole-home check → outdoor cameras + doors/locks/garage. PRIVACY: indoor cameras only when explicitly
asked; default outdoor. When you alert about something seen on a camera, attach it via notify's "camera".
NOTIFY priority by severity: normal=routine FYI; high=wants attention soon (visitor/package/garage open);
critical=genuine safety only (intruder while away, night person, smoke/flood) — critical bypasses
silent/DND, don't overuse.
GUARDRAILS & HONESTY: call_service auto-runs reversible, asks for risky, refuses forbidden; authored
rules whose actions are risky are vetted the same way. "[observe]" = NOT performed (observe mode) — say
you *would*, never claim you did. "[paused]" = kill-switch on — say so. Report tool results faithfully.
Always end with a short spoken reply (call finish, or just reply) — never end a turn silently.
YOUR TEXT IS STREAMED AND SPOKEN ALOUD AS YOU TYPE IT. So: before each tool, give just ONE short, friendly
line about what you're doing right now ("Let me take a look." / "Setting that up."); keep every reply to a
sentence or two; NEVER output internal reasoning, technical detail, entity_ids, or a wall of text.`;

const TOOLS: Anthropic.Tool[] = [
  { name: "get_live_context", description: "Read current live entity states (each tagged with its HA AREA when assigned). Optional domains filter.",
    input_schema: { type: "object", properties: { domains: { type: "array", items: { type: "string" } } } } },
  { name: "get_home_map", description: "The home's AREAS mapped to the entities in each (Backyard, Side Yard, Driveway, Kitchen, …). Use this when a request is SPATIAL — 'watch the backyard', 'all the upstairs lights', 'outside' — so you target EVERY entity in that area instead of guessing by name and missing some. Optional `domains` filters (e.g. ['light'] or ['binary_sensor','camera']). Note: an entity with no area won't appear here — fall back to get_live_context + name matching for those.",
    input_schema: { type: "object", properties: { domains: { type: "array", items: { type: "string" } } } } },
  { name: "get_history", description: "Look at PAST events (HA state history) over a recent window — use for ANY question about what already happened ('what happened overnight?', 'any motion at the front door yesterday?', 'was the garage opened today?'). get_live_context is the CURRENT moment only; this is the past. Defaults to motion/person/door/occupancy sensors if you don't pass `entities`. Returns when each sensor activated (turned on).",
    input_schema: { type: "object", properties: { hours: { type: "number", description: "how many hours back (default 12, max 168)" }, entities: { type: "array", items: { type: "string" }, description: "specific entity_ids to check; omit to scan motion/person/door/occupancy sensors" } } } },
  { name: "call_service", description: "Call an HA service. Reversible runs automatically; risky is deferred for confirmation.",
    input_schema: { type: "object", required: ["domain", "service", "reason"],
      properties: { domain: { type: "string" }, service: { type: "string" }, data: { type: "object" }, reason: { type: "string" } } } },
  { name: "look_at_camera", description: "See live camera snapshot(s). Pass camera entity_ids or names (e.g. ['driveway','aarlo_kitchen']); returns the current image(s) for you to describe. Max 4 per call.",
    input_schema: { type: "object", required: ["cameras"], properties: { cameras: { type: "array", items: { type: "string" } } } } },
  { name: "get_forecast", description: "HA's local weather forecast for the home's exact location. Use this for ANY weather question — never web-search weather. Optional type: daily (default) or hourly.",
    input_schema: { type: "object", properties: { type: { type: "string", enum: ["daily", "hourly"] } } } },
  { name: "get_calendar", description: "Read upcoming events from the household calendars. Use this for ANY schedule question — 'what's on the calendar', 'what's tomorrow', 'am I free Friday', 'what's coming up'. NEVER use call_service for calendar.get_events: it's a response-only service and will fail. Optional `start`/`end` are ISO datetimes bounding the window (default: now through 7 days out); for 'tomorrow', pass tomorrow 00:00 → 23:59 in LOCAL time using the CURRENT DATETIME you were given. Optional `calendars` limits to specific calendar entity_ids (default: every calendar).",
    input_schema: { type: "object", properties: { start: { type: "string" }, end: { type: "string" }, calendars: { type: "array", items: { type: "string" } } } } },
  { name: "notify", description: "Send a push notification. 'camera' (entity_id/name) attaches a live photo. 'priority' sets urgency by YOUR judgment of severity: normal=routine FYI, high=wants attention now (visitor/package), critical=genuine safety only (intruder/smoke/flood) — critical bypasses silent & Do-Not-Disturb and sounds the alarm channel.",
    input_schema: { type: "object", required: ["message"], properties: { message: { type: "string" }, camera: { type: "string" }, priority: { type: "string", enum: ["normal", "high", "critical"] } } } },
  { name: "create_automation", description: "Author a NATIVE Home Assistant automation for anything ongoing, conditional, scheduled, or recurring ('alert me when…', 'every evening…', 'if X then Y', 'watch for… 3 times then stop'). HA runs it natively (cheap triggers, survives restarts, visible/editable in the user's Automations UI) — far better than you polling. `id` is a stable slug (prefix 'cooper_'); `config` is the automation body: {alias, trigger:[...], condition?:[...], action:[...], mode?}. Lifecycle is native: time conditions/triggers for 'today'/'until', a counter or `automation.turn_off` (self-disable) for one-shot / N-times. For the SMART step (e.g. 'is this actually a delivery?', 'who is it?', looking at a camera), the action MUST call service `conversation.process` with data {agent_id:'conversation.cooper', text:'<instruction telling Cooper to look at the specific camera, decide, and notify with the photo>'} — the automation thus calls you back to judge on each real trigger. NEVER substitute a blind tts/notify for the look-and-decide step, and COVER THE WHOLE REQUEST: if the user wants to be told / sent a photo, include that callback (or a notify action) — don't drop it. Resolve real entity_ids first with get_live_context (or get_home_map for whole-area requests).",
    input_schema: { type: "object", required: ["id", "config"], properties: { id: { type: "string" }, config: { type: "object" } } } },
  { name: "list_automations", description: "List existing automations (entity_id, config id, alias, on/off) — use before editing/deleting, or to answer 'what are you watching for / what automations do I have'.",
    input_schema: { type: "object", properties: {} } },
  { name: "delete_automation", description: "Delete an automation by its config `id` (from list_automations). Use when the user says a rule is no longer needed ('stop watching for the delivery', 'nevermind', 'remove that').",
    input_schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  { name: "create_script", description: "Author a NATIVE Home Assistant script for an on-demand TIMED SEQUENCE — steps with delays ('run the pump 10 minutes' = turn on, delay 10m, turn off; presence simulation = a paced, uneven light/media sequence; multi-zone sprinkler run = one zone at a time). HA stores and runs it (visible/editable in Scripts, survives restarts). `id` is a stable slug (prefix 'cooper_'); `config` is the script body: {alias, sequence:[ {service,target/data,...}, {delay:{minutes:10}}, ... ], mode?}. Use `delay` for waits — never rely on yourself to come back. To run it immediately after creating, also call_service script.turn_on with entity_id script.<id> (or service script.<id>). Resolve real entity_ids first with get_live_context. Only reversible actions — risky services are refused.",
    input_schema: { type: "object", required: ["id", "config"], properties: { id: { type: "string" }, config: { type: "object" } } } },
  { name: "list_scripts", description: "List existing scripts (entity_id, id, alias, state) — use before editing/deleting a script.",
    input_schema: { type: "object", properties: {} } },
  { name: "delete_script", description: "Delete a script by its config `id`/object_id (from list_scripts). Use when a sequence is no longer needed.",
    input_schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  { name: "create_counter", description: "Provision a COUNTER helper for counting occurrences ACROSS separate trigger fires — the ONLY correct way to do 'alert me N times then stop' or any cross-event count (repeat.index is loop-only and does NOT count separate triggers). Returns the new counter.* entity_id. Then in your automation: counter.increment it on each fire, gate on its value ({{ states('counter.x')|int >= N }}), and counter.reset at the cycle boundary if it should recur. `name` is a short label (prefix 'cooper'). Create the counter BEFORE the automation that references it.",
    input_schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, initial: { type: "number" }, step: { type: "number" } } } },
  { name: "finish", description: "End the turn. `summary` is spoken ALOUD to the user, so write it as a short, natural sentence addressed to THEM (second person) — e.g. 'Turned on the gym lights.' / 'Have a good workout!' / 'I set up the backyard watch.' NOT a third-person log line like 'User is heading to the gym; acknowledged their departure.'",
    input_schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } } },
];

// Anthropic's native web-search server tool — runs server-side, no separate search key needed.
const WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 5 };

/** Resolve a camera name/entity to an ORDERED list of candidate entity_ids (best first), so callers
 *  can try them until one actually yields a snapshot. Maps "_fluent" → the working "_clear"
 *  substream, de-ranks known-unavailable cams, and de-dupes. Robust to cams that report a healthy
 *  state but whose snapshot 500s (e.g. a dead Wyze) — the caller just falls through to the next. */
function resolveCameras(raw: string, known: Set<string>, bad: Set<string> = new Set()): string[] {
  const swap = (id: string) => (id.endsWith("_fluent") && known.has(id.replace(/_fluent$/, "_clear")) ? id.replace(/_fluent$/, "_clear") : id);
  const direct = raw.startsWith("camera.") ? raw : `camera.${raw}`;
  const matches = known.has(direct)
    ? [direct]
    : [...known].filter((k) => k.startsWith("camera.") && k.includes(raw.toLowerCase().replace(/[^a-z0-9]+/g, "_")));
  const rank = (k: string) => (bad.has(k) ? 2 : 0) + (k.endsWith("_fluent") ? 1 : 0); // working+clear first
  return [...new Set(matches.sort((a, b) => rank(a) - rank(b)).map(swap))];
}

/** Deterministic, sandboxed validation of an authored automation/script BEFORE it's written — host
 *  code, no LLM, so it can't hallucinate the way an LLM self-check can. Verifies every referenced
 *  entity and every service call actually EXISTS (HA saves a rule that names a phantom service/entity
 *  and then fails silently at runtime — this catches it), and lints notify photo attachments. Returns
 *  a list of concrete problems; empty = clean. */
async function validateConfig(ha: HaClient, config: unknown, selfIds: string[] = []): Promise<string[]> {
  const problems: string[] = [];
  const [states, services] = await Promise.all([ha.getStates(), ha.services()]);
  const ids = new Set(states.map((s) => s.entity_id));
  // A self-disabling rule references its OWN entity_id (automation.<id> / script.<id>) in an
  // automation.turn_off action — which doesn't exist YET because we're creating it. Don't flag that.
  for (const self of selfIds) ids.add(self);
  for (const e of collectEntityIds(config)) if (!ids.has(e)) problems.push(`entity "${e}" does not exist — use a real entity_id (check get_live_context)`);
  for (const s of new Set(collectServices(config))) if (services.size && !services.has(s)) problems.push(`service "${s}" does not exist — use a real one (e.g. a real notify.* target; check NOTIFY TARGETS)`);
  lintNotifyPhotos(config, problems);
  return problems;
}

/** Lean SEMANTIC check: does the authored rule actually FULFILL the request? The deterministic
 *  validator proves entities/services are real but can't judge intent — a rule can be perfectly valid
 *  yet wrong ("watch tonight" that stops at 11:59pm). This is one tight, tool-less call (just the
 *  request + the config) — the general catch for intent-mismatches, so we don't hand-code per-case
 *  rules in the prompt. Best-effort: any failure returns ok (never blocks authoring on its own error). */
async function semanticVerify(cfg: Config, request: string, config: unknown): Promise<{ ok: boolean; issues: string[] }> {
  try {
    const anthropic = new Anthropic({ apiKey: cfg.anthropicKey });
    const res = await anthropic.messages.create({
      model: cfg.model, max_tokens: 250,
      system: "You sanity-check an authored Home Assistant rule against what the user EXPLICITLY asked. Take the SIMPLEST reasonable reading of their words; do NOT invent requirements they didn't state. Focus HARD on LIFECYCLE/SCOPE — the #1 failure: if they said 'for N hours' / 'until X' / 'tonight' / 'N times then stop', does the rule ACTUALLY expire or stop accordingly, or will it run indefinitely or cut off at the wrong time? (e.g. a 'for 2 hours' watch that never actually stops after 2h; an overnight 'tonight' rule whose same-day date condition makes it die at midnight; a count that never disables.) Also flag a blatant wrong-target or a missing requested action or an alert that won't reach them. IGNORE pure style and off-by-one nitpicks. Reply ONLY compact JSON — {\"ok\":true}, or {\"ok\":false,\"issues\":[\"<one clear mismatch>\"]} with AT MOST ONE issue. When genuinely unsure, pass.",
      messages: [{ role: "user", content: `REQUEST: ${request}\n\nRULE:\n${JSON.stringify(config)}` }],
    });
    const txt = res.content.filter((c): c is Anthropic.TextBlock => c.type === "text").map((c) => c.text).join("");
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { ok: true, issues: [] };
    const j = JSON.parse(m[0]) as { ok?: boolean; issues?: unknown };
    return { ok: j.ok !== false, issues: Array.isArray(j.issues) ? (j.issues as string[]).slice(0, 1) : [] };
  } catch { return { ok: true, issues: [] }; }
}

/** Runtime hooks the guardian provides: a kill-switch check and an interactive-confirmation sender.
 *  v2 has no watch/sequence engine — durable behavior is authored as native HA automations/scripts —
 *  so the only hooks are the kill-switch and the confirm sender. */
export interface Hooks {
  paused?: () => boolean;
  requestConfirm?: (domain: string, service: string, data: Record<string, unknown>, reason: string) => string;
}

// Short, speakable status for the tools used in a step — streamed to the user as the turn runs so a
// long agentic turn gives running feedback (and the voice pipeline gets a response before it times out)
// instead of 40s of silence. Returns null for a step worth no narration.
// NOTE: each status must be a COMPLETE SENTENCE ending in a period — HA's streaming TTS only speaks
// once it sees a sentence boundary, so a trailing "…" gets buffered (silent) until the final reply.
function stepNarration(toolUses: Anthropic.ToolUseBlock[]): string | null {
  const names = toolUses.map((t) => t.name);
  const has = (n: string) => names.includes(n);
  if (has("create_automation")) return "Setting up the automation.";
  if (has("create_script")) return "Setting up the sequence.";
  if (has("delete_automation") || has("delete_script")) return "Removing that.";
  if (has("look_at_camera")) {
    const cams = (toolUses.find((t) => t.name === "look_at_camera")?.input as { cameras?: unknown })?.cameras;
    return Array.isArray(cams) && cams.length > 1 ? "Looking at the cameras." : "Looking at the camera.";
  }
  if (has("call_service")) return "On it.";
  if (has("get_history")) return "Looking back over what happened.";
  if (has("get_forecast")) return "Checking the forecast.";
  if (has("get_calendar")) return "Checking your calendar.";
  if (has("web_search")) return "Searching.";
  if (has("list_automations") || has("list_scripts")) return "Checking what's set up.";
  if (has("get_home_map") || has("get_live_context")) return "Checking the home.";
  return null;
}

export async function runGoal(cfg: Config, ha: HaClient, goal: string, extraContext = "", budget?: Budget, hooks?: Hooks, onProgress?: (text: string) => void): Promise<string> {
  const anthropic = new Anthropic({ apiKey: cfg.anthropicKey });
  const log: string[] = [];
  let lastConfirmation = ""; // most recent user-facing action result, used as a fallback reply if the agent ends with no text
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `GOAL: ${goal}${extraContext ? `\n\n${extraContext}` : ""}` },
  ];
  const textOf = (content: Anthropic.ContentBlock[]) =>
    content.filter((c): c is Anthropic.TextBlock => c.type === "text").map((c) => c.text).join("").trim();
  // Lazily cache all real entity ids so we can reject hallucinated targets (anti-invention guard).
  let knownIds: Set<string> | null = null;
  const ensureIds = async () => (knownIds ??= new Set((await ha.getStates()).map((s) => s.entity_id)));

  // Ground every eval in HA's REAL location + the CURRENT datetime (so authored time-based automations
  // use the right "now": "at 11:45pm", "today", "every evening") and the REAL notify targets it can put
  // in a rule's notify action. Never let it guess location from entity names.
  let locationLine = "", dateLine = "";
  try {
    const hc = await ha.config();
    const tz = (hc.time_zone as string) || "UTC";
    locationLine = `\n\nHome location: ${hc.location_name ?? "home"} — latitude ${hc.latitude}, longitude ${hc.longitude}, timezone ${tz}. Use this for all geographic reasoning.`;
    const nowStr = new Date().toLocaleString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    dateLine = `\n\nCurrent date & time: ${nowStr} (${tz}). Use THIS as "now" when authoring time-based automations/scripts — compute trigger times, "today"/"tonight"/"until", and recurrence from it.`;
  } catch { /* location optional */ }
  const notifyLine = cfg.notifyTargets.length
    ? `\n\nNOTIFY TARGETS — to alert the user from an authored automation, call one of these EXACT notify services in its action (NOT the generic notify.notify, which may not reach their phone): ${cfg.notifyTargets.map((t) => `notify.${t.replace(/^notify\./, "")}`).join(", ")} (or route the alert through conversation.process to conversation.cooper so a photo can be attached).`
    : `\n\nNOTIFY TARGETS: none configured — alert the user by routing through conversation.process to conversation.cooper.`;
  const systemPrompt = SYSTEM + locationLine + dateLine + notifyLine;
  // PROMPT CACHING (2 breakpoints). Render order is tools → system → messages, so a single
  // cache_control on the (only) system block caches the whole STATIC prefix — TOOLS + WEB_SEARCH +
  // system — which is byte-identical across every eval for the life of the process. Back-to-back
  // watch/heartbeat evals within the 5-min TTL read it at ~0.1x instead of re-billing it each time.
  // (On Haiku 4.5 the min cacheable prefix is 4096 tokens; this prefix may be under that and silently
  //  not cache — harmless, no error — but the rolling message cache below still covers the big stuff.)
  // Cast: prompt caching is GA on the non-beta Messages API and 0.32.1 sends cache_control fine over
  // the wire, but its non-beta TextBlockParam/Usage .d.ts lag the field. Bumping the SDK drops the cast.
  const system = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ] as unknown as Anthropic.MessageCreateParams["system"];
  // ROLLING message cache (the bigger win). Within one multi-step eval the history grows and is
  // re-sent every step — including the ~8k-token get_live_context blob and any camera images. A
  // breakpoint on the last block of the latest message caches that growing prefix: each step's new
  // content is written once (~1.25x) and read at ~0.1x on every later step, so get_live_context is
  // billed at full price ONCE, not once per step. Strip-then-set keeps exactly one message-level
  // marker (system + rolling = 2 total, under the 4-per-request cap and the 20-block lookback).
  const rollCache = (msgs: Anthropic.MessageParam[]) => {
    for (const m of msgs) if (Array.isArray(m.content)) for (const b of m.content) delete (b as { cache_control?: unknown }).cache_control;
    const last = msgs[msgs.length - 1]?.content;
    if (Array.isArray(last) && last.length) (last[last.length - 1] as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
  };

  header(`▶ GOAL  ${C.reset}${C.bold}${goal}${C.reset}  ${C.gray}(observe=${cfg.observeMode}, model=${cfg.model})`);
  const narrated = new Set<string>(); // streamed status lines already said this turn — don't repeat them
  const semChecked = new Set<string>(); // rule ids already semantic-checked this turn — don't re-nitpick (anti-loop)
  for (let step = 0; step < 12; step++) {
    rollCache(messages);
    const params = {
      model: cfg.model, max_tokens: 4096, system, // 4096: room for multi-action turns (e.g. many sprinkler zones) without truncating
      tools: [...TOOLS, WEB_SEARCH] as Anthropic.MessageCreateParams["tools"], messages,
    };
    // TOKEN-STREAM when a progress sink is wired: forward Cooper's words as they generate (first words
    // in ~1s instead of waiting for the whole step), so the voice pipeline starts speaking immediately.
    // No sink (autonomous/judge calls) → plain create. finalMessage() yields the same Message for tools.
    let res: Anthropic.Message;
    if (onProgress) {
      if (step > 0) onProgress(" "); // separate this step's words from the previous step's (no run-on)
      const s = anthropic.messages.stream(params as Anthropic.MessageStreamParams);
      s.on("text", (delta) => onProgress(delta));
      res = await s.finalMessage();
    } else {
      res = await anthropic.messages.create(params as Anthropic.MessageCreateParamsNonStreaming);
    }
    budget?.recordCall(Date.now(), res.usage);
    messages.push({ role: "assistant", content: res.content });
    // Skip logging the narration on a finish turn — the green "✔ finish" line already says it.
    const finishing = res.content.some((c) => c.type === "tool_use" && c.name === "finish");
    if (!finishing) for (const c of res.content) if (c.type === "text" && c.text.trim()) L(`  ${C.think}💭 ${c.text.trim().slice(0, 240)}${C.reset}`);
    if (res.content.some((c) => (c as any).type === "server_tool_use")) L(`    ${C.cyan}🌐 web_search (native)${C.reset}`);
    const toolUses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
    const u = res.usage as Anthropic.Usage & { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    L(`  ${C.gray}step ${step}: ${toolUses.length} tool call(s) [stop_reason=${res.stop_reason}] tok in=${u.input_tokens} out=${u.output_tokens} cache(w=${u.cache_creation_input_tokens ?? 0} r=${u.cache_read_input_tokens ?? 0})${C.reset}`);
    // Cooper's words for this step already streamed live (the .on("text") above). If it called a tool
    // WITHOUT narrating, drop in one short controlled status so there's still feedback. Deduped.
    if (onProgress && !finishing && !textOf(res.content)) { const n = stepNarration(toolUses); if (n && !narrated.has(n)) { narrated.add(n); onProgress(` ${n}`); } }
    // No client tool calls → Claude has answered directly (text, already streamed). Return it for history.
    if (toolUses.length === 0) return textOf(res.content) || lastConfirmation || "Okay — done.";

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      const a = t.input as any;
      let out = "";
      if (t.name === "finish") {
        L(`${C.green}${C.bold}✔ finish:${C.reset}${C.green} ${a.summary}${C.reset}`);
        // If Cooper already wrote its answer as text (streamed), the finish summary is a DUPLICATE — don't
        // re-speak it; keep the text as the answer. Only voice the summary when there was no text answer.
        const streamed = textOf(res.content);
        if (onProgress && !streamed) onProgress(` ${a.summary}`);
        return streamed || a.summary;
      }
      else if (t.name === "create_automation") {
        // Enforce a clear Cooper convention regardless of what the model passed: id prefix `cooper_`,
        // alias prefix `[Cooper] `, and a description recording the request — so it's unmistakable in
        // the user's Automations UI and Cooper can find/manage its own.
        let id = String(a.id ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || `rule_${Date.now()}`;
        if (!id.startsWith("cooper_")) id = `cooper_${id}`;
        const cfg2 = { ...(a.config && typeof a.config === "object" ? a.config : {}) } as Record<string, unknown>;
        const rawAlias = String(cfg2.alias ?? id).replace(/^\[Cooper\]\s*/i, "").trim();
        cfg2.alias = `[Cooper] ${rawAlias}`;
        cfg2.id = id;
        cfg2.description = `Created by Cooper. Request: ${goal}`.slice(0, 255);
        // Vet the rule's OWN actions: it runs natively with no human in the loop, so a risky action it
        // performs would bypass the per-call confirm flow. Refuse to author anything not fully auto-tier.
        const vet = vetConfig(cfg2);
        if (vet.never.length) out = `REFUSED: this automation would perform forbidden action(s): ${vet.never.join(", ")}. Not creating it.`;
        else if (vet.confirm.length) out = `REFUSED: this automation would AUTONOMOUSLY do risky action(s) (${vet.confirm.join(", ")}) with no human in the loop — that bypasses the confirm safeguard. Re-author it so the rule NOTIFIES the user (or calls conversation.process to alert with camera context) and a person decides; keep only reversible actions automatic.`;
        else {
          // Deterministic gate: refuse to write a rule that names a phantom entity/service (caught here,
          // not silently at 3am when it fails to fire). The agent fixes and re-authors.
          // Deterministic gate (HARD — phantom entities/services can't be faked; self-reference allowed).
          const problems = await validateConfig(ha, cfg2, [`automation.${id}`]);
          if (problems.length) out = `NOT CREATED — real, checked problems; fix them and call create_automation again with the SAME id:\n- ${problems.join("\n- ")}`;
          else {
            try {
              await ha.upsertAutomation(id, cfg2); // SAVE first — entities/services are real
              lastConfirmation = `Set it up — automation "${cfg2.alias}" is live.`;
              // Semantic check is ADVISORY and runs ONCE per rule (never blocks, never loops): surface at
              // most one blatant mismatch as a note the agent MAY act on, then move on.
              let note = "";
              if (!semChecked.has(id)) {
                semChecked.add(id);
                const sem = await semanticVerify(cfg, goal, cfg2);
                if (!sem.ok && sem.issues[0]) note = ` One thing to double-check: ${sem.issues[0]} — if that's off, call create_automation again with the SAME id to fix it; otherwise just confirm and finish.`;
              }
              out = `created automation ${id} ("${cfg2.alias}") — live.${note || " Confirm to the user and finish."}`;
            }
            catch (e) { out = `ERROR creating automation: ${String(e).slice(0, 200)}`; }
          }
        }
        L(`    ${C.cyan}🤖 create_automation(${id}) -> ${out}${C.reset}`); log.push(out);
      }
      else if (t.name === "list_automations") {
        const all = await ha.automations();
        const mine = all.filter((x) => (x.id ?? "").startsWith("cooper_") || x.alias.startsWith("[Cooper]"));
        out = JSON.stringify((mine.length ? mine : all).map((x) => ({ id: x.id, alias: x.alias, state: x.state, cooper: (x.id ?? "").startsWith("cooper_") || x.alias.startsWith("[Cooper]") })));
        L(`    ${C.cyan}🤖 list_automations -> ${all.length} total, ${mine.length} cooper${C.reset}`); log.push(`listed ${all.length} automations`);
      }
      else if (t.name === "delete_automation") {
        const id = String(a.id ?? "").trim();
        if (!id) out = "no id given";
        else { try { await ha.deleteAutomation(id); out = `deleted automation ${id}`; lastConfirmation = "Removed that automation."; } catch (e) { out = `ERROR deleting: ${String(e).slice(0, 200)}`; } }
        L(`    ${C.cyan}🤖 delete_automation(${id}) -> ${out}${C.reset}`); log.push(out);
      }
      else if (t.name === "create_script") {
        // Same [Cooper] convention as automations: id prefix cooper_, alias prefix [Cooper].
        let id = String(a.id ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || `seq_${Date.now()}`;
        if (!id.startsWith("cooper_")) id = `cooper_${id}`;
        const sc = { ...(a.config && typeof a.config === "object" ? a.config : {}) } as Record<string, unknown>;
        const rawAlias = String(sc.alias ?? id).replace(/^\[Cooper\]\s*/i, "").trim();
        sc.alias = `[Cooper] ${rawAlias}`;
        sc.description = `Created by Cooper. Request: ${goal}`.slice(0, 255);
        const vet = vetConfig(sc);
        if (vet.never.length) out = `REFUSED: this script would perform forbidden action(s): ${vet.never.join(", ")}. Not creating it.`;
        else if (vet.confirm.length) out = `REFUSED: this script would perform risky action(s) (${vet.confirm.join(", ")}) unattended. Scripts are for reversible timed sequences (lights/switches/media/pump/watering) — for a risky action, ask the user to confirm it directly instead of scripting it.`;
        else {
          const problems = await validateConfig(ha, sc, [`script.${id}`]);
          if (problems.length) out = `NOT CREATED — fix these real problems and call create_script again with the SAME id:\n- ${problems.join("\n- ")}`;
          else {
            try {
              await ha.upsertScript(id, sc);
              lastConfirmation = `Set it up — script "${sc.alias}" is ready.`;
              let note = "";
              if (!semChecked.has(id)) {
                semChecked.add(id);
                const sem = await semanticVerify(cfg, goal, sc);
                if (!sem.ok && sem.issues[0]) note = ` One thing to double-check: ${sem.issues[0]} — fix with create_script (same id) if off, else just confirm.`;
              }
              out = `created script ${id} ("${sc.alias}") — run with script.turn_on entity_id script.${id}.${note || " Confirm to the user and finish."}`;
            }
            catch (e) { out = `ERROR creating script: ${String(e).slice(0, 200)}`; }
          }
        }
        L(`    ${C.cyan}🎬 create_script(${id}) -> ${out}${C.reset}`); log.push(out);
      }
      else if (t.name === "list_scripts") {
        const all = await ha.scripts();
        const mine = all.filter((x) => x.id.startsWith("cooper_") || x.alias.startsWith("[Cooper]"));
        out = JSON.stringify((mine.length ? mine : all).map((x) => ({ id: x.id, alias: x.alias, state: x.state, cooper: x.id.startsWith("cooper_") || x.alias.startsWith("[Cooper]") })));
        L(`    ${C.cyan}🎬 list_scripts -> ${all.length} total, ${mine.length} cooper${C.reset}`); log.push(`listed ${all.length} scripts`);
      }
      else if (t.name === "delete_script") {
        const id = String(a.id ?? "").trim().replace(/^script\./, "");
        if (!id) out = "no id given";
        else { try { await ha.deleteScript(id); out = `deleted script ${id}`; lastConfirmation = "Removed that script."; } catch (e) { out = `ERROR deleting: ${String(e).slice(0, 200)}`; } }
        L(`    ${C.cyan}🎬 delete_script(${id}) -> ${out}${C.reset}`); log.push(out);
      }
      else if (t.name === "create_counter") {
        let nm = String(a.name ?? "").trim().replace(/^\[?cooper\]?\s*/i, "").trim() || "count";
        nm = `Cooper ${nm}`.slice(0, 60);
        const ent = await ha.createCounter(nm, Number(a.initial) || 0, Number(a.step) || 1);
        out = ent ? `created ${ent} (initial ${Number(a.initial) || 0}, step ${Number(a.step) || 1}) — increment/reset it from your automation and gate on its value` : "ERROR: could not create counter";
        L(`    ${C.cyan}🔢 create_counter -> ${out}${C.reset}`); log.push(out);
      }
      else if (t.name === "get_live_context") {
        const [ents, areas] = await Promise.all([ha.liveContext(a.domains), ha.areaMap()]);
        const compact = ents.map((e) => {
          const at = e.attributes as Record<string, unknown>;
          const o: Record<string, unknown> = { id: e.entity_id, name: at.friendly_name, state: e.state };
          const area = areas.get(e.entity_id);
          if (area) o.area = area; // so "the backyard" can resolve to every entity in that area
          for (const k of ["current_temperature", "temperature", "humidity", "device_class"])
            if (at[k] !== undefined) o[k] = at[k];
          return o;
        });
        out = JSON.stringify(compact).slice(0, 30000);
        L(`    ${C.cyan}🔍 get_live_context(${(a.domains ?? ["all"]).join(",")}) -> ${compact.length} entities${C.reset}`);
      }
      else if (t.name === "get_home_map") {
        // Areas → their entities (optionally filtered by domain), so authoring something spatial ("the
        // backyard", "all the upstairs lights") can target a whole area instead of guessing by name.
        const [states, areas] = await Promise.all([ha.getStates(), ha.areaMap()]);
        const want: string[] | undefined = Array.isArray(a.domains) && a.domains.length ? a.domains : undefined;
        const byArea: Record<string, string[]> = {};
        for (const s of states) {
          const area = areas.get(s.entity_id);
          if (!area) continue;
          if (want && !want.includes(s.entity_id.split(".")[0])) continue;
          (byArea[area] ??= []).push(s.entity_id);
        }
        out = JSON.stringify(byArea).slice(0, 30000);
        const unassigned = states.filter((s) => !areas.get(s.entity_id)).length;
        L(`    ${C.cyan}🗺 get_home_map(${want?.join(",") ?? "all"}) -> ${Object.keys(byArea).length} areas, ${unassigned} unassigned${C.reset}`);
      }
      else if (t.name === "get_history") {
        const hours = Math.min(Math.max(Number(a.hours) || 12, 1), 168);
        const end = Date.now(); const start = end - hours * 3600_000;
        await ensureIds();
        // Explicit entities, or default to the "what happened" sensors (motion/person/door/occupancy/safety).
        let ents: string[] = Array.isArray(a.entities) ? (a.entities as string[]).filter((e) => knownIds!.has(e)) : [];
        if (!ents.length) {
          const states = await ha.getStates();
          const CLASSES = new Set(["motion", "occupancy", "door", "window", "presence", "opening", "garage_door", "smoke", "gas", "moisture", "safety"]);
          ents = states.filter((s) => s.entity_id.startsWith("binary_sensor.") &&
            (CLASSES.has(String(s.attributes?.device_class)) || /_(person|motion|vehicle|animal|pet|package|face)\b/.test(s.entity_id))).map((s) => s.entity_id);
        }
        ents = ents.slice(0, 60);
        const hist = await ha.getHistory(ents, start, end);
        // Digest to the meaningful signal: when each sensor turned "on".
        const events: Array<{ entity: string; name?: string; activations: number; at: string[] }> = [];
        for (const arr of hist) {
          if (!arr.length) continue;
          const id = (arr[0] as { entity_id?: string }).entity_id ?? "";
          const name = (arr[0].attributes as Record<string, unknown> | undefined)?.friendly_name as string | undefined;
          const at: string[] = []; let prev = "";
          for (const p of arr) {
            const st = (p as { state: string }).state;
            if (st === "on" && prev !== "on") at.push((p as { last_changed?: string; last_updated?: string }).last_changed ?? (p as any).last_updated ?? "");
            prev = st;
          }
          if (at.length) events.push({ entity: id, name, activations: at.length, at: at.slice(0, 20) });
        }
        events.sort((x, y) => y.activations - x.activations);
        out = events.length
          ? JSON.stringify({ window_hours: hours, since: new Date(start).toISOString(), detections: events }).slice(0, 16000)
          : `No activations in the last ${hours}h across ${ents.length} sensor(s) checked. Quiet.`;
        L(`    ${C.cyan}🕘 get_history(${hours}h, ${ents.length} ents) -> ${events.length} active${C.reset}`); log.push(`history ${hours}h: ${events.length} sensor(s) had activity`);
      }
      else if (t.name === "look_at_camera") {
        const names: string[] = [a.cameras].flat().filter(Boolean);
        const states = await ha.getStates();
        knownIds ??= new Set(states.map((s) => s.entity_id));
        const badCams = new Set(states.filter((s) => s.entity_id.startsWith("camera.") && ["unavailable", "unknown"].includes(s.state)).map((s) => s.entity_id));
        const blocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
        for (const raw of names.slice(0, 4)) {
          const cands = resolveCameras(raw, knownIds!, badCams);
          if (!cands.length) { blocks.push({ type: "text", text: `no such camera: ${raw}` }); continue; }
          let snap = null, used = "";
          for (const ent of cands) { snap = await ha.cameraSnapshot(ent); if (snap) { used = ent; break; } } // try until one works
          if (!snap) { blocks.push({ type: "text", text: `${raw}: no working camera (tried ${cands.join(", ")})` }); continue; }
          blocks.push({ type: "text", text: `Camera ${used}:` });
          blocks.push({ type: "image", source: { type: "base64", media_type: snap.mediaType, data: snap.base64 } });
        }
        const nImg = blocks.filter((b) => b.type === "image").length;
        budget?.recordImages(nImg);
        L(`    ${C.cyan}📷 look_at_camera(${names.join(",")}) -> ${nImg} image(s)${C.reset}`); log.push(`looked at ${nImg} camera(s)`);
        results.push({ type: "tool_result", tool_use_id: t.id, content: blocks.length ? blocks : [{ type: "text", text: "no images" }] });
        continue;
      }
      else if (t.name === "get_forecast") {
        const fc = await ha.getForecast(a.type === "hourly" ? "hourly" : "daily");
        out = fc ? JSON.stringify(fc.forecast.slice(0, 8)) : "no weather entity configured in HA";
        L(`    ${C.cyan}🌤 get_forecast(${a.type ?? "daily"}) -> ${fc ? (fc.forecast.length + " entries") : "none"}${C.reset}`);
      }
      else if (t.name === "get_calendar") {
        const cal = await ha.getCalendar(a.start, a.end, a.calendars);
        const nonEmpty = Object.fromEntries(Object.entries(cal).filter(([, ev]) => (ev as unknown[]).length));
        const total = Object.values(cal).reduce((n, ev) => n + (ev as unknown[]).length, 0);
        out = Object.keys(cal).length ? JSON.stringify(nonEmpty) : "no calendars configured in HA";
        L(`    ${C.cyan}📅 get_calendar(${Object.keys(cal).length} cal) -> ${total} event(s)${C.reset}`);
      }
      else if (t.name === "notify") {
        // Notify is how Cooper TALKS to you — it always fires, even in observe mode (which only
        // suppresses device actions). Optionally attach the live camera photo.
        const data: Record<string, unknown> = {};
        if (a.camera) { await ensureIds(); const ent = resolveCameras(a.camera, knownIds!)[0]; if (ent) data.image = `/api/camera_proxy/${ent}`; }
        const pr = String(a.priority ?? "normal").toLowerCase();
        if (pr === "high") Object.assign(data, { importance: "high", priority: "high", ttl: 0 });
        else if (pr === "critical" || pr === "emergency") // bypass silent/DND, sound the alarm channel
          Object.assign(data, { importance: "high", priority: "high", ttl: 0, channel: "alarm_stream" });
        if (!cfg.notifyTargets.length) out = "[no notify_targets configured] " + a.message;
        else { try { for (const tgt of cfg.notifyTargets) await ha.notify(tgt, "Cooper", a.message, data); out = `notified[${pr}]` + (data.image ? " (+photo)" : ""); lastConfirmation = a.message; } catch (e) { out = `notify failed: ${String(e).slice(0, 150)}`; } }
        L(`    ${C.magenta}📲 notify[${pr}]${data.image ? " 📸" : ""} -> ${out}${C.reset}`); log.push(out);
      } else if (t.name === "call_service") {
        const ids: string[] = [a.data?.entity_id].flat().filter(Boolean);
        await ensureIds();
        const missing = ids.filter((id) => !knownIds!.has(id));
        const tier = tierFor(a.domain, a.service);
        if (missing.length) out = `ERROR: no such entity: ${missing.join(", ")} — these do not exist; do NOT claim to control them`;
        else if (tier === "never") out = "REFUSED (forbidden action)";
        else if (hooks?.paused?.()) out = "[paused] Cooper is paused (kill-switch on) — not acting; tell the user it's paused";
        else if (tier === "confirm") {
          // Ask for confirmation (in-chat for a conversation, push for autonomous). Even in observe
          // mode we still ASK — the resolver reports "would" instead of acting, so the whole confirm
          // flow is exercisable without actuation.
          if (hooks?.requestConfirm) out = hooks.requestConfirm(a.domain, a.service, a.data ?? {}, a.reason ?? "");
          else if (cfg.observeMode) out = `[observe] would ask you to confirm ${a.domain}.${a.service}`;
          else out = `DEFERRED for user confirmation: ${a.domain}.${a.service} (${a.reason})`;
        }
        else if (cfg.observeMode) out = `[observe] would call ${a.domain}.${a.service} ${JSON.stringify(a.data ?? {})}`;
        else {
          // A single failing service call must NOT abort the whole eval — feed the error back as a
          // tool result so the agent can adjust (wrong service/params/entity) and keep going. After a
          // successful call, READ THE ENTITY BACK and only report success if it actually reached the
          // target state — a 200 just means HA accepted the call, not that the device obeyed (e.g. a
          // lock with no subscription stays unlocked). Never claim "done" on an effect that didn't land.
          try {
            await ha.callService(a.domain, a.service, a.data ?? {});
            const v = await ha.verifyServiceEffect(a.service, a.data ?? {});
            out = v.ok ? (v.detail ? `done (${v.detail})` : "done")
              : `SENT but NOT confirmed — ${v.detail}. The action did not take effect; tell the user it didn't work / may need attention and do NOT claim you did it.`;
          }
          catch (e) { out = `ERROR: ${a.domain}.${a.service} failed (${String(e).slice(0, 200)}) — NOT done. Fix the service/params/entity and retry, or skip it; keep handling the other actions.`; }
        }
        const oc = out.startsWith("done") ? C.green : out.startsWith("ERROR") || out.startsWith("REFUSED") ? C.red : C.yellow;
        L(`    ${oc}⚙ call_service ${a.domain}.${a.service} [${tier}] -> ${out}${C.reset}`); log.push(`${a.domain}.${a.service} [${tier}] -> ${out}`);
      }
      results.push({ type: "tool_result", tool_use_id: t.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }
  L(`${C.red}■ stopped (max steps)${C.reset}`);
  return "stopped (max steps). actions:\n" + log.join("\n");
}
