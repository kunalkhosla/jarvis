# Changelog

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
