# Changelog

## 1.5.0
- **A general semantic check replaces per-case prompt rules.** When an authored rule is mechanically
  valid but doesn't match what you *meant* (a "watch tonight" that stops at 11:59pm), there was no
  general catch — so fixes kept getting hard-coded into the prompt, drifting back toward the
  feature-by-feature engine v2 set out to kill. Now, after the deterministic entity/service check, one
  tight semantic pass asks "does this rule actually fulfill the request?" (scope, lifecycle, every
  action, does the alert reach you) and makes Cooper fix it before saving. Because that catch is general,
  the **use-case-specific prompt wording was stripped** — the prompt now states only the bounded HA
  *mechanisms* (date condition, midnight-crossing window, self-disable, photo format) and lets Cooper
  reason which fits.
- **Progress is now Cooper's own words, spoken live.** Instead of fixed status lines, each step streams a
  short natural sentence from Cooper ("Sure, let me take a look around." / "Checking the front cameras.")
  — varied, deduped (no more "Checking the home. Checking the home."), and pluralized for multiple
  cameras.

## 1.4.2
- **"Tonight" / overnight watches no longer cut off at midnight.** Authoring conflated "today" with
  "tonight" and used a same-day date condition, so a "watch the front door tonight" rule stopped at
  11:59pm — missing the small hours, when a late visitor matters most. Cooper now knows overnight spans
  midnight and uses an overnight time window (e.g. 6pm→6am via `after` > `before`) instead of pinning to
  one calendar date. "Today" (a full calendar day) still uses the date condition.

## 1.4.1
- **Streamed progress is now spoken, not just shown.** The step statuses ended in "…", and HA's
  streaming TTS only speaks complete sentences — so progress appeared as text but stayed silent until
  the final reply (~15-20s of no audio). Each status is now a complete sentence ending in a period
  ("Checking the home." / "Looking at the camera."), so the voice starts within a couple of seconds.

## 1.4.0
- **Streaming responses — running feedback instead of dead air.** A long agentic turn (authoring,
  camera checks) used to sit silent for 30-50s, long enough that the Assist **voice pipeline timed out
  and only text came back, no speech**. Now the add-on streams a short, speakable status for each step
  ("Checking the home…", "Looking at the camera…", "Setting up the automation…") and then the final
  reply, and the conversation integration feeds those into HA's chat-log stream — so you hear/see
  progress within a second or two and the voice pipeline gets a response in time to speak it.
- Requires the **Cooper integration via HACS at 0.3.0** alongside this add-on. The streaming path
  degrades safely: if a Home Assistant version doesn't support the chat-log streaming API, the
  integration automatically falls back to the previous single-reply behavior (no breakage).

## 1.3.1
- **Faster authoring** — the deterministic validator now guarantees an authored rule's entities and
  services are real, so Cooper no longer spends an extra LLM round-trip re-reading and self-verifying
  what it just wrote. One fewer model call per automation/script. (Streaming responses, the real fix for
  the voice-pipeline timeout on long turns, are the next step.)

## 1.3.0
- **Deterministic validation of authored rules (sandboxed, no LLM).** Before an automation/script is
  saved, the host checks — against the real registries — that every `entity_id` and every
  `domain.service` it references actually EXISTS, and lints notify photo attachments (`data.image` vs a
  silently-ignored `data.camera`). HA will happily save a rule that calls a phantom service and then
  fail silently at 3am; this catches it at authoring and makes the agent fix it. Can't be fooled the way
  an LLM self-check can. (Found a real case: a delivery watch that named a `notify.mobile_app_galaxy_s23_ultra`
  service that doesn't exist — the alert would never have fired.)
- **Cooper knows which phone you're on.** The conversation integration now forwards the caller's
  `device_id` and `user_id`, so when you say "ping me" / "text me," Cooper targets *your own phone's*
  notify service (resolved from the device) instead of guessing — and it knows who's speaking. Requires
  updating the **Cooper integration via HACS to 0.2.0** as well as this add-on.

## 1.2.0
- **Stop encoding per-use-case rules; reason from grounded context + self-verify.** The prompt was
  drifting back toward `O(use-cases)` special cases ("deliveries go to the front door", "AI sensors beat
  motion") — the exact thing v2 set out to kill, just moved from code into prose. Replaced that with two
  general mechanisms:
  - **Grounding:** Cooper picks entities from the real home, not name guesses — `get_live_context` tags
    each entity with its **area** and **device_class**, and `get_home_map` gives areas → entities. It's
    told to choose the entities that fit and the *most specific* sensor for the subject (a person sensor
    for a person, not a broad motion one), and that classifying *what/who* (a delivery, a stranger) is
    its own vision job via the `conversation.process` callback — not a hardcoded rule.
  - **Self-verification:** after authoring, `create_automation`/`create_script` hand the **stored rule
    back** to Cooper, which re-reads it against the full request (every clause present? right triggers?
    correct lifecycle? does the alert deliver?) and fixes it (same id) before claiming it's set up. One
    general check that catches wrong entities, no-op "today" windows, and missing alerts at once —
    instead of a new prompt rule per mistake.
- Kept only bounded HA-schema facts (the "today" date condition, the notify `image:` format, self-disable
  for one-shot) — those are finite facts about HA, not per-use-case branches.

## 1.1.1
- **Log timestamps are now in your local timezone** (adopted from HA's configured timezone at boot)
  instead of UTC.
- **Better authored rules — fixes found in live testing:**
  - **"today / tonight" actually scopes to today.** A `00:00–23:59` time window is true *every* day
    forever and scopes nothing; Cooper now uses a date condition built from the current date so the rule
    goes dormant after today.
  - **AI detection over plain motion.** For who/what-specific watches (a person, a delivery, a car),
    Cooper triggers on the cameras' `*_person` / `*_vehicle` / `*_animal` AI sensors rather than plain
    `*_motion` / `*_occupancy` (which fire on wind, passing cars, pets). Since there's no "package"
    sensor, a *delivery* watch triggers on driveway/front vehicle+person and then calls back to Cooper
    to visually confirm it's actually a delivery.
  - **Watches the right place.** Deliveries/visitors trigger on front-door/driveway/front-yard sensors,
    not side-yard or interior/garage.
  - **Photos actually attach.** Authored notify actions use `data: {image: "/api/camera_proxy/<cam>"}`
    (a bare `camera:` key is ignored by the app), and prefer your specific notify targets over the
    generic `notify.notify`.

## 1.1.0
- **Area-awareness — Cooper now knows the home's layout.** It reads HA's area registry, tags every
  entity in `get_live_context` with its area, and has a new `get_home_map` tool (areas → their
  entities). So a spatial request — "watch the backyard", "all the upstairs lights", "outside" — targets
  *every* entity in that area instead of guessing by name and missing some. Entities with no area fall
  back to name matching. (Assigning your outdoor cameras/sensors to their areas, or labeling them, makes
  this even sharper.)
- **Cooper verifies actions actually took effect before claiming success (#2).** A `200` from a service
  call only means HA accepted it, not that the device obeyed — so Cooper now reads the entity back and
  only says "done" if it reached the target state (lock→locked, cover→open, etc.). If it didn't take
  (e.g. a lock that won't lock), it says so instead of falsely claiming success. Applies to direct
  actions and both confirmation paths.
- **Authored rules cover the WHOLE request, with the judgment step wired as a callback (#1).** Fixes
  rules that dropped the "tell me / send a photo" part or just played a TTS "let me check the camera"
  and then didn't. The smart step (look at a camera, decide who/what) must now call `conversation.process`
  back to `conversation.cooper` so Cooper actually looks and notifies with the photo on each trigger —
  never a blind TTS stand-in.
- **Running a script no longer needs a needless confirm (#3).** `script`/`automation` are auto-tier, so
  Cooper can run its own just-authored (and already-vetted) script immediately instead of asking
  permission to press go.
- **Spoken replies sound like speech (#4).** `finish` summaries are now natural second-person sentences
  ("Turned on the gym lights.") instead of third-person log lines ("User is heading to the gym…").

## 1.0.0
- **Cooper is now a routing agent over Home Assistant — the bespoke watch/automation engine is gone.**
  Instead of reimplementing an automation engine feature-by-feature (watch/do/task/sequence goal types,
  `reactive`/`whileAway`/`untilPresent`/`firesLeft` flags, NL-time regexes, intent regexes), Cooper
  reads each request and **routes by its nature**: answer a question, do a reversible action, ask Yes/No
  for a risky one, or — for anything ongoing/conditional/scheduled/recurring — **author a native HA
  automation or script** that HA runs itself. Durable behavior lives in HA (cheap triggers, survives
  restarts, visible/editable in the UI); Cooper no longer polls. For the smart step, an authored rule
  calls `conversation.process` back to `conversation.cooper` to judge ("is this actually a delivery?").
- **New: `create_script` / `list_scripts` / `delete_script`** — Cooper authors native HA scripts for
  on-demand timed sequences (run the pump 10 min, presence simulation, multi-zone sprinkler runs) with
  real `delay` steps instead of holding the sequence in the add-on. Same `[Cooper]` / `cooper_` tagging
  as automations.
- **Authored rules are guardrailed at authoring time.** Because a native rule runs with no human in the
  loop, every service it references is tiered: a forbidden action is refused, and a *risky* one is
  refused with a nudge to notify the user (or call back to judge) instead of doing it autonomously — so
  authoring can't bypass the per-action confirm safeguard.
- **The agent is grounded in the current date/time and your real notify targets**, so it authors
  "at 11:45pm" / "today" / "every evening" rules and alert actions correctly.
- **Removed:** `start_watch` / `cancel_watch` / `schedule_actions` tools, the watch/heartbeat loops,
  scheduled tasks/sequences, the morning briefing, and all intent regexes. A morning briefing (and any
  recurring routine) is now something Cooper authors as a normal time-triggered automation. The
  `heartbeat_seconds` and `briefing_time` options are gone. Conversation, guardrails, budget tracking,
  the kill-switch, and in-chat/push Yes-No confirmations are unchanged.

## 0.28.0
- **v2 foundation — Cooper authors native HA automations.** New `create_automation` /
  `list_automations` / `delete_automation` tools: Cooper writes real Home Assistant automations (via
  the config API + reload) that HA runs natively — cheap triggers, survive restarts, visible/editable
  in the Automations UI — instead of Cooper polling. For the smart step, an authored automation calls
  `conversation.process` back to Cooper (`conversation.cooper`) to judge ("is this actually a
  delivery?"). Cooper-authored automations are clearly tagged: **id prefixed `cooper_`, alias prefixed
  `[Cooper] `**, and a description recording the request. Additive this release — the routing prompt and
  removal of the old watch/do/sequence engine follow (this is step 1 of the v2 "routing agent over HA"
  redesign).

## 0.27.0
- **Watch evals no longer try to re-create themselves (the big fix).** A watch-engine eval re-read the
  watch's own monitoring-phrased text + the "for monitoring intent, call start_watch" rule and tried to
  set the watch up *again* — which fails inside an eval ("cannot create a persistent watch in this
  context") and derailed the whole eval into rambling about HA automations instead of checking the
  scene. Watch evals now run with an explicit frame ("you're running an ALREADY-ACTIVE watch — never
  start_watch/cancel_watch; look at the camera that fired and notify only if it matches"), and a stray
  `start_watch` in that context is redirected instead of erroring.
- **Cooper knows what it's watching now — manage watches by voice.** Each conversation turn is given
  the list of active watches, so "nevermind, I got the package" / "they're here" / "that's done"
  cancels the matching watch via `cancel_watch` (previously the agent had no idea a watch existed and
  just chatted back).
- **Forward vs backward intent.** "if you see X, notify me" / "watch for X today" → `start_watch`
  (forward); "did you see X?" / "any X last night?" → `get_history` (backward). Fixes a regression where
  a forward "if you see a person at the door" request was answered by checking history ("no alerts
  needed") instead of setting up the watch.
- **No more "(no response)".** When the agent ends a turn with no text (e.g. right after `start_watch`),
  `runGoal` now returns the last action confirmation instead of an empty reply.
- `/healthz` reports each watch's `mode` (event | periodic).

## 0.26.0
- **Cooper can answer "what happened?" now (#10).** New `get_history` tool queries HA state history
  over a window, so questions about the **past** ("any motion overnight?", "was the garage opened
  today?") are answered from real history instead of being silently answered with *current* state
  (which is what made "any movements from last night?" report a person standing there *right now*).
  Defaults to motion/person/door/occupancy sensors, digests to when each one activated; the system
  prompt now routes past-tense questions to it.

## 0.25.0
- **Watch intent is agent-classified now (watch-engine v2, part 1 — #9).** Removed the keyword regex
  that decided watch-vs-not — it mis-fired both ways: it *missed* "if you see motion, notify me" (ran
  once, no watch, then falsely claimed to be watching), and it *created a persistent watch from the
  question* "any movements from last night's watch?" (the word "watch"). The agent now reads intent and
  calls `start_watch` to set up monitoring; a question is just answered. "Stop watching" stays
  deterministic (never depends on an LLM call).
- **Watches have a mode (part 2 — supersedes #8).** `start_watch` takes `mode`: **event** (react to a
  specific trigger — no idle polling) or **periodic** (open-ended oversight — also re-checks on a
  timer). The agent infers it from intent and asks if unclear. **Event/reactive watches skip the
  heartbeat**, so a "notify me if motion" watch stays idle until its events fire instead of burning the
  cost-guard budget every `heartbeat_seconds` (which could otherwise starve real event evals). New
  `reactive` column on goals (migrated in place).
- Not yet: an event still evals *every* watch (O(events × watches) fan-out) — trigger-scoped evals,
  tiered cheap-filter-then-judge, and prioritized backpressure are the next parts of #9.

## 0.24.0
- **Cooper sets up its own watches now — no more missed intent or false "I'm watching".** Previously a
  deterministic keyword regex decided watch-vs-one-shot; phrasings like *"if you see motion on any
  camera, send me a notification"* matched nothing, so the request ran **once** and Cooper then
  **falsely claimed** it was monitoring. New `start_watch` tool: on a conversation turn the agent
  registers a persistent watch itself whenever it recognizes ongoing monitoring / conditional alerting
  ("if/when you see X notify me", "while I'm asleep/away, watch…"). The system prompt now forbids
  claiming to watch/monitor/alert unless `start_watch` was actually called. The keyword fast-path stays
  for obvious cases; `start_watch` is offered **only** on conversation turns, so autonomous watch
  evals can't spawn nested watches.

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
