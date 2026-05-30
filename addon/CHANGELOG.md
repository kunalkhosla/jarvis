# Changelog

## 0.23.0
- **The `input_text` voice bridge is gone.** Cooper is now reached only through the **Cooper
  conversation integration** (`custom_components/cooper/`) over `POST /ask`. Removed: the
  `cooper_watch_request` / `cooper_response` helpers, the self-provisioned **Ask Cooper** script, the
  ~9s wait/reply logic, and the routing-prompt setup step. On first run the add-on now self-provisions
  only the **kill-switch** (`input_boolean.cooper_pause`). *Migrating: delete the three orphaned
  entities (`script.cooper_watch`, `input_text.cooper_watch_request`, `input_text.cooper_response`)
  manually.* The autonomous **push** Yes/No confirmation path is retained (for a watch acting while no
  conversation is open).
- **F1 safety fix: scheduled sequences respect observe mode.** `fireDueSteps` now skips real
  `ha.callService` when `observe_mode` is on (previously a scheduled presence-sim / multi-zone run
  fired for real even in observe mode). With the in-chat-confirm observe fix in 0.22, observe mode is
  now leak-free across immediate actions, confirmations, and scheduled sequences.

## 0.22.0
- **In-chat confirmations.** A confirm-tier action (lock, alarm, valve, garage close, siren) raised
  during a conversation now asks a **yes/no right in the reply** and resolves on your next turn —
  "Lock the front door — yes or no?" → "yes". No more tapping a push notification. The push path is
  kept for *autonomous* confirmations (a watch acting while no conversation is open). Keyed by
  `session_id`; affirmative/negative is matched deterministically and the pending ask expires after
  5 minutes.
- **Observe mode now rehearses the whole confirm flow** without acting — it still asks, and on "yes"
  reports what it *would* do. This also fixes a latent leak where a confirmed action (push or in-chat)
  executed even in observe mode.
- Removed a duplicate reply log line (`→ …` duplicated the `✔ finish:` line).

## 0.21.0
- **New `POST /ask` endpoint — the foundation for Cooper as a native Assist agent.** A request
  (`{text, session_id, history?}`) runs the full eval and returns `{reply}` synchronously — no
  `input_text` mailbox, no 255-char cap, no cross-request answer bleed. The stop/watch/do routing
  that lived inside the voice-bridge handler is now a shared `handleUtterance()` used by both `/ask`
  and the legacy bridge, and it accepts recent conversation `history` so follow-ups resolve
  ("turn it off" → the thing from the last turn).
- **New custom integration `custom_components/cooper/`** (ships in this repo, HACS-installable):
  registers Cooper directly as a Home Assistant **conversation agent** that calls `/ask`. Selecting
  it as your Assist conversation agent replaces the old stock-LLM-agent + Ask Cooper script + mailbox
  bridge with one brain and a direct request/response. The legacy `input_text` bridge still works in
  parallel for now (removed in a later release once the integration is proven).

## 0.20.0
- **Cooper now answers out loud, in the same breath.** The voice bridge was fire-and-forget — the
  assistant only ever said "handing that to Cooper" and the real reply arrived later as a push. The
  **Ask Cooper** script now sets the request, then **blocks up to ~9s** waiting for Cooper to write its
  reply to a new `input_text.cooper_response` helper, and returns it so the assistant **speaks Cooper's
  answer inline**. Quick things ("is the garage closed?", "stop watching", camera checks) come back
  conversationally; longer agentic tasks time out gracefully with "On it — I'll notify you" and Cooper
  delivers the result by push as before. No double-talk: a reply spoken inline isn't also pushed.
- **Self-provisioned, no config edits.** First run creates the `cooper_response` helper, and the script
  is now **re-written on every start** (idempotent upsert), so existing installs pick up the new
  wait/reply sequence automatically on update — nothing to paste.

## 0.19.0
- **Scheduled sequences are now first-class and persisted.** `schedule_actions` no longer spawns a
  pile of anonymous `setTimeout`s — steps are saved to SQLite (a new `seq_steps` table) and fired by a
  single tick loop. So a multi-step plan (presence simulation, a multi-zone sprinkler run) **survives a
  restart / add-on update** instead of being silently lost, and steps overdue from downtime are skipped
  (not fired late — no 3am watering).
- **Visible & cancelable.** `/healthz` now lists active `sequences` (label, steps, done, next-step ETA);
  `DELETE /sequence/:id` cancels one; `cancel_watch` / the voice "stop" cancel sequences as a unit and
  report real counts.

## 0.18.0
- **Running sequences can actually be stopped now.** `schedule_actions` timers are registered with the
  host, so `cancel_watch` (and the voice "stop watching / stand down") now also `clearTimeout`s the
  still-pending steps — previously a mid-run multi-zone sprinkler sequence kept firing future zones even
  after you said "stop," because the sequence is scheduled timers, not a watch. `cancel_watch` now
  covers watches **and** scheduled sequences, and reports the real counts (no more false "stopped").

## 0.17.2
- **Sprinkler durations are honored now.** A zone's `switch.turn_on` runs the zone's app-configured
  default time and ignores the minutes you ask for (so "15 min" came out as the zone default). Watering
  services are now treated as reversible/auto (matched by service name — `*_watering` /
  `*_zone_schedule`, not brand-locked), and the prompt tells the agent to use the integration's
  duration-capable start service (duration in seconds) and to sequence multi-zone runs with
  `schedule_actions` at cumulative offsets — no confirmations either way.

## 0.17.1
- **No more confirmation spam.** A risky action across many entities is now one `call_service` with an
  `entity_id` list → a single Yes/No for the whole set, not one prompt per entity. A hard backstop also
  refuses fanning out more than 3 pending prompts at once. (A "start every sprinkler zone" request had
  produced a dozen separate prompts.)
- **Timed runs use the right pattern.** System prompt now tells the agent that `turn_on` doesn't take a
  duration param — to run something for N minutes, turn it on and `schedule_actions` the turn-off; for
  sequential timed zones, schedule each on/off at cumulative offsets. Reversible/auto, zero prompts.

## 0.17.0
- **A failing service call no longer aborts the whole eval.** `call_service` (and `notify`) errors are
  caught and fed back to the agent as a tool result, so a single bad call (e.g. a 400 on one sprinkler
  zone) lets it adjust and keep handling the rest instead of crashing the run.
- **`max_tokens` 1024 → 4096** so multi-action turns (e.g. starting many zones at once) aren't
  truncated mid-output (`stop_reason=max_tokens`).
- **Stop watching actually works now** (two ways): a deterministic phrase-detector in the voice bridge
  ("stop watching" / "remove all watches" / "stand down") cancels watches with no LLM involved, and a
  new `cancel_watch` tool lets the agent stand watches down itself. Previously "remove all watches" was
  mis-read as a request to *create* a watch (the word "watch" matched the create intent), so it never
  stopped.

## 0.16.0
- **Prompt caching** on the agent loop — two `cache_control` breakpoints: one on the system block
  caches the static TOOLS + system prefix across evals (5-min TTL covers back-to-back watch/heartbeat
  checks), and a rolling breakpoint on the latest message caches the growing conversation within a
  multi-step eval — so the big `get_live_context` blob is billed at full price once per eval, not once
  per step, and read at ~0.1x thereafter. `/healthz` and the per-step logs now show cache write/read
  tokens so you can see it working.
- Fix: confirm-tier actions no longer spawn duplicate Yes/No prompts when the agent re-asks in a
  later loop step (dedupe pending confirmations by action). Caught in end-to-end testing — a single
  "arm the alarm" produced two prompts && two executes.

## 0.15.0
- **Interactive confirmation** (cooper#2): risky (confirm-tier) actions now send an actionable
  Yes/No notification to your phone and run **only if you tap Yes** (5-min expiry) — instead of
  just deferring and reporting. The approval executes the held action and notifies the result.
- **Kill-switch**: a self-provisioned `input_boolean.cooper_pause` — turn it on and Cooper halts all
  device actions (and won't fire queued sequences) while still observing + notifying. Synced live.
- (Proximity-based arrival prep tracked separately as #3 — needs HA's Proximity integration.)

## 0.14.0
- Self-provisions the voice bridge on first run: creates the `input_text` helper + the "Ask Cooper"
  script and exposes it to Assist (idempotent — only what's missing). Setup drops to a single
  routing-hint paste in the conversation agent. README architecture diagram refreshed (shows the
  bridge; generic wake word).

## 0.13.1
- Watch engine now reacts to camera AI-detection sensors (person/vehicle/animal/package) that
  carry no device_class — previously only raw "_motion" sensors triggered it, so the more
  meaningful "person detected" events from cameras were being ignored.

## 0.13.0
- Voice bridge now forwards ANY request to Cooper, not just "watch" intents. Say something to the
  phone assistant that needs scheduling, presence simulation, a camera check, or a multi-step task,
  and it hands the full request to the guardian, which runs it and notifies the result back — the
  phone becomes a thin mic for the guardian.

## 0.12.0
- Cooper can now plan and run timed action SEQUENCES itself (new schedule_actions tool). Ask it to
  "make it look like someone's home" and it designs a believable, uneven on/off light schedule and
  the steps fire on their own over time — no scripting, no LLM per step. Reversible actions only;
  risky ones are rejected.

## 0.11.6
- Camera lookup now tries candidate cameras until one actually returns an image — so a name like
  "driveway" no longer fails on a dead cam that reports a healthy state; it falls through to a
  working stream.
- Logs no longer repeat the answer as a 💭 reasoning line right before the ✔ finish line.

## 0.11.5
- Weather now comes from HA's own forecast for your exact location, via a new get_forecast tool
  (discovers the weather entity by domain — no hardcoded names). Replaces web-searching weather,
  which reverse-geocoded coordinates to a nearby town and could be flat wrong (wrong town AND
  wrong conditions).

## 0.11.4
- Fix: location reasoning (weather, etc.) is now grounded in HA's real configured location
  (lat/lon/timezone), injected into every eval. Previously, with no location, the model could
  guess a place from entity/SSID names (e.g. a "...Dakota..." network name → wrong county/state).
  System prompt also forbids inferring geography from device names.

## 0.11.3
- Logs: reasoning (💭) lines now use magenta — HA's log viewer doesn't render the 256-color violet
  from 0.11.2 (it showed plain). Basic ANSI renders reliably.

## 0.11.2
- Logs: reasoning lines now use a distinct violet color with a 💭 marker (were washed-out dim),
  so thinking reads apart from tool calls and results.

## 0.11.1
- Fix: a malformed POST body crashed the whole add-on (unhandled JSON parse → process exit →
  supervisor restart). Now returns `400 invalid JSON`; the request handler and process are guarded
  so no input can take Cooper down. (Found via adversarial testing.)

## 0.11.0
- Standing "while away" watch: "keep an eye whenever we're out" arms automatically when everyone
  leaves and stands down when someone's home — set once, re-arms every time (distinct from the
  one-shot until-home watch).

## 0.10.0
- Deferred / triggered do-goals: "prepare the home for my arrival" or "in an hour…" becomes a
  scheduled task (fires at a time, or when someone arrives home) instead of running immediately.
- Tasks persist, show in `/healthz`, and are cancelable via `DELETE /task/:id`.

## 0.9.0
- Presence-aware stand-down: an away-watch ("keep an eye while we're out") stands down when
  everyone is home again — deterministic, gated so arming-while-home won't instant-cancel.

## 0.8.0
- Time-boxed watches: "watch until Monday evening" / "for 2 hours" auto-stands-down when the window
  ends. Presence-simulation guidance so "make it look like someone's home" is lived-in, not robotic.

## 0.7.0
- Alerts carry an agent-chosen priority: normal / high / critical. Critical bypasses silent &
  Do-Not-Disturb (alarm channel) — Cooper decides the urgency by severity.

## 0.6.0
- Photo-in-alert: notifications can attach a live camera snapshot. Notify now fires even in
  observe mode (observe gates device actions, not how Cooper talks to you).
- Visitor classification (delivery / known / unknown), whole-home "check on the house" tour.
- Optional daily morning briefing. Color/structured add-on logs.

## 0.5.0
- Camera vision: `look_at_camera` fetches a live snapshot and Cooper *sees* the scene (Reolink
  full-res falls back to the working substream).
- Cost guard: per-hour / per-day caps on automatic LLM calls, token accounting in `/healthz`.

## 0.4.0
- SQLite persistence: watch-goals and an action log survive restarts.

## 0.3.0
- Phone → guardian bridge: register a watch-goal by talking to the HA voice assistant.

## 0.2.2
- Anti-hallucination guard: `call_service` rejects entities that don't exist.

## 0.2.1
- Native Anthropic web search (dropped the separate search-provider key).

## 0.2.0
- Watch engine: react to relevant home events (filtered, debounced, cooldown) + heartbeat.

## 0.1.0
- Initial guardian scaffold: Claude tool-use loop, tiered guardrails, observe-mode, `/healthz`,
  `POST /goal`.
