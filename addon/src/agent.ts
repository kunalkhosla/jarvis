import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { HaClient } from "./ha.js";
import { tierFor } from "./guardrails.js";
import type { Budget } from "./budget.js";
import { C, L, header } from "./log.js";

const SYSTEM = `You are Cooper, a home agent for a Home Assistant smart home.
You are given a GOAL and live home state. Reason about what (if anything) to do RIGHT NOW.
- Use get_live_context to read state before acting or answering.
- Act via call_service. Reversible actions (lights/fans/media/climate) run automatically; risky
  ones (locks, alarm, valve, garage/awning close, sirens) need confirmation — call_service sends the
  user a Yes/No on their phone and returns "Asked the user to confirm…" (it runs only if they tap
  Yes; don't claim it's done). If it returns "[paused]", Cooper's kill-switch is on — tell the user
  it's paused and you didn't act. Never invent entities.
- RUN-FOR-A-DURATION: plain turn_on (switch/light/fan) takes NO duration param (passing one fails) —
  to run such a device for N minutes, turn it ON and schedule_actions the turn_off after N×60 seconds.
  IRRIGATION/SPRINKLERS differ: a zone's switch.turn_on runs the zone's app-configured DEFAULT time and
  ignores the minutes you asked for — to honor a requested duration use the irrigation integration's
  start service that takes a "duration" in SECONDS (e.g. a *_watering service targeting the zone). For
  several zones with their own run times, schedule each zone's timed start at the cumulative offset with
  schedule_actions (controllers run one zone at a time). Watering services are reversible/auto — no
  confirmations.
- ONE CONFIRMATION PER DECISION: if a risky (confirm-tier) action applies to several entities, make a
  SINGLE call_service with entity_id as a LIST — that's one Yes/No for the whole set, not one prompt
  per entity. Never fire a separate confirmation for each entity.
- Only act when the goal warrants it; for watch-goals, often the right answer is "nothing to do".
- ONGOING MONITORING: a single reply does NOT keep watching. If the user wants continuous monitoring
  or conditional alerting — "keep an eye on…", "if/when you see/detect X, notify me", "let me know
  if…", "while I'm asleep/away/out, watch…" — you MUST call start_watch with a self-contained goal
  (what to watch + when to alert). Pick mode: 'event' for a specific trigger (alert WHEN X happens —
  reacts to events, no idle polling) or 'periodic' for open-ended oversight ("keep an eye on the
  house" — re-checks on a timer too); ASK if it's genuinely unclear. NEVER say you're "watching",
  "monitoring", or "will alert you" unless you actually called start_watch this turn. A QUESTION about
  the past or current state ("did anything happen last night?", "is the door open?") is NOT a watch —
  just answer it; do not call start_watch.
- STOP / STAND DOWN: to stop watching, cancel a watch, OR stop a running scheduled sequence (e.g. a
  multi-zone sprinkler run still in progress with more zones queued), you MUST call cancel_watch (omit
  "match" for everything, or pass a phrase to target some). Saying you stopped is NOT enough — watches
  keep re-checking and scheduled steps keep firing until cancel_watch actually cancels them. To also
  turn off things already running right now, call the matching off/stop service too (e.g. stop_watering
  / switch.turn_off).
- CAMERAS: the detection sensors (binary_sensor *_person / *_motion / *_occupancy) only tell you
  SOMETHING happened. To know WHAT, use look_at_camera to actually see the scene, then describe
  who/what is there before deciding or alerting. Prefer the camera nearest the triggered sensor.
  For a person at an entrance, CLASSIFY: delivery / known visitor / unknown — and say which.
  For a whole-home check ("is everything okay", "check on the house"), look at the OUTDOOR cameras
  (driveway, yards, entries — infer from names) and check doors/locks/garage, then summarize.
  PRIVACY: only look at indoor cameras when the goal explicitly calls for it; default to outdoor.
- When you ALERT about something you saw on a camera, pass that camera as notify's "camera" arg so
  the user gets the PHOTO alongside your message.
- Choose notify "priority" by your own judgment of severity: normal for routine FYIs; high for
  things that want attention soon (a visitor, a package, garage left open); critical ONLY for
  genuine safety (an unrecognized person while away, someone at night, smoke/fire/flood/leak) —
  critical bypasses silent & Do-Not-Disturb, so do not overuse it.
- PRESENCE SIMULATION ("make it look like someone's home", away/vacation watch): make the home look
  lived-in, never robotic. PLAN the whole sequence yourself with schedule_actions — pick believable,
  UNEVEN timings (not a fixed metronome), follow dusk/bedtime, nudge one or two rooms at a time, wind
  down to a single light then off. Schedule it in one shot; the steps then fire on their own. Avoid
  outdoor/security lights blazing all night. Needs observe_mode off to actually act.
- ARRIVAL PREP ("prepare the home for my arrival"): make it welcoming for right now — comfortable
  climate, entry/main lights on if it's dark (check the sun), maybe gentle media; don't touch
  bedrooms or anything disruptive. Reversible only; confirm anything risky. Needs observe_mode off
  to actually act.
- You have built-in web search for live external facts. Use notify to alert the user. Call finish when done.
- WEATHER: always use get_forecast (HA's forecast for your exact coordinates). NEVER web-search
  weather — web results reverse-geocode to a nearby town and are often wrong.
- LOCATION: a "Home location" line is provided below — use ONLY that for anything geographic
  (weather, sunrise, traffic, local search). NEVER infer location from device/network/entity/SSID
  names (e.g. a street or Wi-Fi name like "...Dakota..." is NOT a place); they are not geography.
- REPORT FAITHFULLY from tool results: if call_service returns "[observe]" the action was NOT
  performed (observe mode) — say you *would* do it, never claim you did. If it returns "DEFERRED",
  it needs the user's confirmation — say so, don't claim success.`;

const TOOLS: Anthropic.Tool[] = [
  { name: "get_live_context", description: "Read current live entity states. Optional domains filter.",
    input_schema: { type: "object", properties: { domains: { type: "array", items: { type: "string" } } } } },
  { name: "call_service", description: "Call an HA service. Reversible runs automatically; risky is deferred for confirmation.",
    input_schema: { type: "object", required: ["domain", "service", "reason"],
      properties: { domain: { type: "string" }, service: { type: "string" }, data: { type: "object" }, reason: { type: "string" } } } },
  { name: "look_at_camera", description: "See live camera snapshot(s). Pass camera entity_ids or names (e.g. ['driveway','aarlo_kitchen']); returns the current image(s) for you to describe. Max 4 per call.",
    input_schema: { type: "object", required: ["cameras"], properties: { cameras: { type: "array", items: { type: "string" } } } } },
  { name: "get_forecast", description: "HA's local weather forecast for the home's exact location. Use this for ANY weather question — never web-search weather. Optional type: daily (default) or hourly.",
    input_schema: { type: "object", properties: { type: { type: "string", enum: ["daily", "hourly"] } } } },
  { name: "schedule_actions", description: "Schedule a SEQUENCE of reversible actions to run over time — YOU plan the believable timing. Use for presence simulation ('make it look like someone's home') or anything spread across minutes/hours. Each step fires after 'after_seconds' from now. Reversible actions only (lights/fans/media/climate); risky ones are rejected.",
    input_schema: { type: "object", required: ["steps"], properties: { steps: { type: "array", items: {
      type: "object", required: ["after_seconds", "domain", "service"],
      properties: { after_seconds: { type: "number" }, domain: { type: "string" }, service: { type: "string" }, data: { type: "object" }, note: { type: "string" } } } } } } },
  { name: "notify", description: "Send a push notification. 'camera' (entity_id/name) attaches a live photo. 'priority' sets urgency by YOUR judgment of severity: normal=routine FYI, high=wants attention now (visitor/package), critical=genuine safety only (intruder/smoke/flood) — critical bypasses silent & Do-Not-Disturb and sounds the alarm channel.",
    input_schema: { type: "object", required: ["message"], properties: { message: { type: "string" }, camera: { type: "string" }, priority: { type: "string", enum: ["normal", "high", "critical"] } } } },
  { name: "cancel_watch", description: "Stand down active watch-goals AND stop pending scheduled/timed sequences (e.g. a multi-zone sprinkler run still mid-sequence) so they stop running, re-checking, and firing future steps. Omit 'match' to cancel EVERYTHING; pass a phrase to target a subset. Call this whenever the user asks to stop watching, stop/cancel a running sequence, remove a watch, or stand down.",
    input_schema: { type: "object", properties: { match: { type: "string" } } } },
  { name: "start_watch", description: "Set up a PERSISTENT background watch so the guardian keeps checking the home and ALERTS the user until cancelled. Use whenever the user wants ongoing monitoring or conditional alerting: 'keep an eye on…', 'if/when you see/detect X, notify me', 'let me know if…', 'while I'm asleep/away, watch…'. Pass a self-contained `goal` (WHAT to watch + WHEN/how to alert). Choose `mode`: 'event' for a specific trigger (alert WHEN X happens — reacts to events, no idle polling, cheaper) or 'periodic' for open-ended oversight ('keep an eye on the house' — also re-checks on a timer). If you genuinely can't tell which the user wants, ASK before calling. A QUESTION about the past/current state is NOT a watch — just answer it.",
    input_schema: { type: "object", required: ["goal", "mode"], properties: { goal: { type: "string" }, mode: { type: "string", enum: ["event", "periodic"] } } } },
  { name: "finish", description: "End: summarize what you did / decided.",
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

/** Runtime hooks the guardian provides: a kill-switch check and an interactive-confirmation sender. */
export interface Hooks {
  paused?: () => boolean;
  requestConfirm?: (domain: string, service: string, data: Record<string, unknown>, reason: string) => string;
  /** Stand down watch-goals AND stop pending scheduled sequences. Omit match for all; pass a phrase to target a subset. */
  cancelWatches?: (match?: string) => string;
  /** Register a PERSISTENT watch-goal (ongoing monitoring / conditional alerting). `mode`: 'event'
   *  (react to triggers, no heartbeat) or 'periodic' (also re-check on a timer). Returns confirmation.
   *  Only present on the conversation path — autonomous evals can't spawn watches. */
  startWatch?: (goal: string, mode?: "event" | "periodic") => string;
  /** Persist + schedule a timed action sequence (validated, auto-tier steps). The host fires due steps
   *  on a tick — survives restarts, shows in /healthz, and is cancelable as a unit. Returns a summary. */
  scheduleSequence?: (label: string, steps: Array<{ afterSeconds: number; domain: string; service: string; data?: Record<string, unknown>; note?: string }>) => string;
}

export async function runGoal(cfg: Config, ha: HaClient, goal: string, extraContext = "", budget?: Budget, hooks?: Hooks): Promise<string> {
  const anthropic = new Anthropic({ apiKey: cfg.anthropicKey });
  const log: string[] = [];
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `GOAL: ${goal}${extraContext ? `\n\n${extraContext}` : ""}` },
  ];
  const textOf = (content: Anthropic.ContentBlock[]) =>
    content.filter((c): c is Anthropic.TextBlock => c.type === "text").map((c) => c.text).join("").trim();
  // Lazily cache all real entity ids so we can reject hallucinated targets (anti-invention guard).
  let knownIds: Set<string> | null = null;
  const ensureIds = async () => (knownIds ??= new Set((await ha.getStates()).map((s) => s.entity_id)));

  // Ground every eval in HA's REAL location so geographic reasoning never guesses from entity names.
  let locationLine = "";
  try {
    const hc = await ha.config();
    locationLine = `\n\nHome location: ${hc.location_name ?? "home"} — latitude ${hc.latitude}, longitude ${hc.longitude}, timezone ${hc.time_zone}. Use this for all geographic reasoning.`;
  } catch { /* location optional */ }
  const systemPrompt = SYSTEM + locationLine;
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
  for (let step = 0; step < 12; step++) {
    rollCache(messages);
    const res = await anthropic.messages.create({
      model: cfg.model, max_tokens: 4096, system, // 4096: room for multi-action turns (e.g. many sprinkler zones) without truncating
      tools: [...TOOLS, WEB_SEARCH] as Anthropic.MessageCreateParams["tools"], messages,
    });
    budget?.recordCall(Date.now(), res.usage);
    messages.push({ role: "assistant", content: res.content });
    // Skip logging the narration on a finish turn — the green "✔ finish" line already says it.
    const finishing = res.content.some((c) => c.type === "tool_use" && c.name === "finish");
    if (!finishing) for (const c of res.content) if (c.type === "text" && c.text.trim()) L(`  ${C.think}💭 ${c.text.trim().slice(0, 240)}${C.reset}`);
    if (res.content.some((c) => (c as any).type === "server_tool_use")) L(`    ${C.cyan}🌐 web_search (native)${C.reset}`);
    const toolUses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
    const u = res.usage as Anthropic.Usage & { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    L(`  ${C.gray}step ${step}: ${toolUses.length} tool call(s) [stop_reason=${res.stop_reason}] tok in=${u.input_tokens} out=${u.output_tokens} cache(w=${u.cache_creation_input_tokens ?? 0} r=${u.cache_read_input_tokens ?? 0})${C.reset}`);
    // No client tool calls → Claude has answered directly (text). Return that.
    if (toolUses.length === 0) return textOf(res.content) || "(no response)";

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      const a = t.input as any;
      let out = "";
      if (t.name === "finish") { L(`${C.green}${C.bold}✔ finish:${C.reset}${C.green} ${a.summary}${C.reset}`); return a.summary; }
      else if (t.name === "cancel_watch") {
        out = hooks?.cancelWatches ? hooks.cancelWatches(typeof a.match === "string" ? a.match : undefined) : "cannot cancel watches in this context";
        L(`    ${C.yellow}🛑 cancel_watch(${a.match ?? "all"}) -> ${out}${C.reset}`); log.push(out);
      }
      else if (t.name === "start_watch") {
        const wg = String(a.goal ?? "").trim() || goal;
        const mode = a.mode === "event" || a.mode === "periodic" ? a.mode : undefined;
        out = hooks?.startWatch ? hooks.startWatch(wg, mode) : "cannot create a persistent watch in this context";
        L(`    ${C.cyan}👁 start_watch(${mode ?? "?"}) -> ${out}${C.reset}`); log.push(out);
      }
      else if (t.name === "get_live_context") {
        const ents = await ha.liveContext(a.domains);
        const compact = ents.map((e) => {
          const at = e.attributes as Record<string, unknown>;
          const o: Record<string, unknown> = { id: e.entity_id, name: at.friendly_name, state: e.state };
          for (const k of ["current_temperature", "temperature", "humidity", "device_class"])
            if (at[k] !== undefined) o[k] = at[k];
          return o;
        });
        out = JSON.stringify(compact).slice(0, 30000);
        L(`    ${C.cyan}🔍 get_live_context(${(a.domains ?? ["all"]).join(",")}) -> ${compact.length} entities${C.reset}`);
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
      else if (t.name === "schedule_actions") {
        const steps: any[] = Array.isArray(a.steps) ? a.steps.slice(0, 30) : [];
        await ensureIds();
        const planned: string[] = [];
        const valid: Array<{ afterSeconds: number; domain: string; service: string; data?: Record<string, unknown>; note?: string }> = [];
        for (const s of steps) {
          const delay = Math.max(0, Number(s.after_seconds) || 0);
          const tier = tierFor(s.domain, s.service);
          const ids: string[] = [s.data?.entity_id].flat().filter(Boolean);
          const missing = ids.filter((id) => !knownIds!.has(id));
          if (missing.length) { planned.push(`✗ no such entity: ${missing.join(",")}`); continue; }
          if (tier !== "auto") { planned.push(`✗ ${s.domain}.${s.service} needs confirmation — not scheduling`); continue; }
          valid.push({ afterSeconds: delay, domain: s.domain, service: s.service, data: s.data, note: s.note });
          planned.push(`+${delay}s ${s.domain}.${s.service} ${s.note ?? ""}`);
        }
        // Hand the validated steps to the host, which persists them and fires due steps on a tick —
        // so the sequence survives restarts, shows in /healthz, and cancel_watch can stop it as a unit.
        const sched = valid.length && hooks?.scheduleSequence ? hooks.scheduleSequence(goal, valid) : "";
        out = planned.length ? `scheduled ${valid.length}/${steps.length}${sched ? ` (${sched})` : ""}:\n${planned.join("\n")}` : "no steps";
        L(`    ${C.cyan}⏲ schedule_actions -> ${valid.length}/${steps.length} step(s)${sched ? ` ${sched}` : ""}${C.reset}`); log.push(`scheduled ${valid.length} timed action(s)`);
      }
      else if (t.name === "get_forecast") {
        const fc = await ha.getForecast(a.type === "hourly" ? "hourly" : "daily");
        out = fc ? JSON.stringify(fc.forecast.slice(0, 8)) : "no weather entity configured in HA";
        L(`    ${C.cyan}🌤 get_forecast(${a.type ?? "daily"}) -> ${fc ? (fc.forecast.length + " entries") : "none"}${C.reset}`);
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
        else { try { for (const tgt of cfg.notifyTargets) await ha.notify(tgt, "Cooper", a.message, data); out = `notified[${pr}]` + (data.image ? " (+photo)" : ""); } catch (e) { out = `notify failed: ${String(e).slice(0, 150)}`; } }
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
          // tool result so the agent can adjust (wrong service/params/entity) and keep going.
          try { await ha.callService(a.domain, a.service, a.data ?? {}); out = "done"; }
          catch (e) { out = `ERROR: ${a.domain}.${a.service} failed (${String(e).slice(0, 200)}) — NOT done. Fix the service/params/entity and retry, or skip it; keep handling the other actions.`; }
        }
        const oc = out === "done" ? C.green : out.startsWith("ERROR") || out.startsWith("REFUSED") ? C.red : C.yellow;
        L(`    ${oc}⚙ call_service ${a.domain}.${a.service} [${tier}] -> ${out}${C.reset}`); log.push(`${a.domain}.${a.service} [${tier}] -> ${out}`);
      }
      results.push({ type: "tool_result", tool_use_id: t.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }
  L(`${C.red}■ stopped (max steps)${C.reset}`);
  return "stopped (max steps). actions:\n" + log.join("\n");
}
