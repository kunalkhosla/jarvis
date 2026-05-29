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
- Only act when the goal warrants it; for watch-goals, often the right answer is "nothing to do".
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

  header(`▶ GOAL  ${C.reset}${C.bold}${goal}${C.reset}  ${C.gray}(observe=${cfg.observeMode}, model=${cfg.model})`);
  for (let step = 0; step < 12; step++) {
    const res = await anthropic.messages.create({
      model: cfg.model, max_tokens: 1024, system: systemPrompt,
      tools: [...TOOLS, WEB_SEARCH] as Anthropic.MessageCreateParams["tools"], messages,
    });
    budget?.recordCall(Date.now(), res.usage);
    messages.push({ role: "assistant", content: res.content });
    // Skip logging the narration on a finish turn — the green "✔ finish" line already says it.
    const finishing = res.content.some((c) => c.type === "tool_use" && c.name === "finish");
    if (!finishing) for (const c of res.content) if (c.type === "text" && c.text.trim()) L(`  ${C.think}💭 ${c.text.trim().slice(0, 240)}${C.reset}`);
    if (res.content.some((c) => (c as any).type === "server_tool_use")) L(`    ${C.cyan}🌐 web_search (native)${C.reset}`);
    const toolUses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
    L(`  ${C.gray}step ${step}: ${toolUses.length} tool call(s) [stop_reason=${res.stop_reason}]${C.reset}`);
    // No client tool calls → Claude has answered directly (text). Return that.
    if (toolUses.length === 0) return textOf(res.content) || "(no response)";

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      const a = t.input as any;
      let out = "";
      if (t.name === "finish") { L(`${C.green}${C.bold}✔ finish:${C.reset}${C.green} ${a.summary}${C.reset}`); return a.summary; }
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
        for (const s of steps) {
          const delay = Math.max(0, Number(s.after_seconds) || 0);
          const tier = tierFor(s.domain, s.service);
          const ids: string[] = [s.data?.entity_id].flat().filter(Boolean);
          const missing = ids.filter((id) => !knownIds!.has(id));
          if (missing.length) { planned.push(`✗ no such entity: ${missing.join(",")}`); continue; }
          if (tier !== "auto") { planned.push(`✗ ${s.domain}.${s.service} needs confirmation — not scheduling`); continue; }
          // Fire later from the running process (deterministic, no LLM at fire time).
          setTimeout(() => {
            if (hooks?.paused?.()) { L(`    ${C.yellow}⏲ paused — skipped ${s.domain}.${s.service}${C.reset}`); return; }
            ha.callService(s.domain, s.service, s.data ?? {}).catch(() => {});
            L(`    ${C.green}⏲ fired: ${s.domain}.${s.service} ${JSON.stringify(s.data ?? {})} ${s.note ? `(${s.note})` : ""}${C.reset}`);
          }, delay * 1000);
          planned.push(`+${delay}s ${s.domain}.${s.service} ${s.note ?? ""}`);
        }
        out = planned.length ? `scheduled ${planned.filter((p) => !p.startsWith("✗")).length}/${steps.length}:\n${planned.join("\n")}` : "no steps";
        L(`    ${C.cyan}⏲ schedule_actions -> ${steps.length} step(s)${C.reset}`); log.push(`scheduled ${steps.length} timed action(s)`);
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
        else { for (const tgt of cfg.notifyTargets) await ha.notify(tgt, "Cooper", a.message, data); out = `notified[${pr}]` + (data.image ? " (+photo)" : ""); }
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
          if (cfg.observeMode) out = `[observe] would ask you to confirm ${a.domain}.${a.service}`;
          else if (hooks?.requestConfirm) out = hooks.requestConfirm(a.domain, a.service, a.data ?? {}, a.reason ?? "");
          else out = `DEFERRED for user confirmation: ${a.domain}.${a.service} (${a.reason})`;
        }
        else if (cfg.observeMode) out = `[observe] would call ${a.domain}.${a.service} ${JSON.stringify(a.data ?? {})}`;
        else { await ha.callService(a.domain, a.service, a.data ?? {}); out = "done"; }
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
