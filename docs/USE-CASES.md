# Use-case catalog

What a Claude + Home Assistant routing agent can do, given a typical well-instrumented home (climate,
cameras with person detection, locks, alarm, irrigation, pool, whole-home energy monitoring,
calendars, weather, presence, media players, a water shutoff valve).

**How the durable ones work.** Cooper is a routing agent, not a background watcher. When you ask for
something that needs to keep running, Cooper *authors a native Home Assistant automation or script* —
a real rule that shows up in your Automations/Scripts UI, that you can read, edit, or delete. HA runs
it natively on its own triggers. When a step needs judgment (e.g. "is that a real person at the
door?"), the authored rule calls `conversation.process` back to `conversation.cooper` to look and
decide. There is no Cooper-side watch loop, heartbeat, or stored goal — the home's own automation
engine does the running.

So:
- **"N times then stop"** → a real HA counter helper the authored rule increments and checks.
- **"tonight" / "until Monday" / "while I'm away"** → native HA time and presence conditions on the rule.
- **Presence simulation** → a native HA script Cooper writes and the automation calls.
- **The smart call** → the rule hands the snapshot/context to Cooper via `conversation.process`.

## Guardian / watch (judgment-based monitoring)

Each of these is something Cooper sets up by **writing a native automation** that triggers on the
relevant sensors and, where judgment is needed, calls Cooper back to look and decide.

- **"Keep an eye while I'm out"** — Cooper writes an automation triggered by motion/door/camera
  sensors, gated on a "nobody home" presence condition; when it fires it calls Cooper to weigh the
  event against context and send a contextual alert ("a door opened, no one's home").
- **"Look after the house / the kids are home"** — an authored rule (or small set) covering comfort
  (climate + fans + dusk lights), safety (smoke/CO/door triggers), and periodic check-ins. Engaged
  manually only — never auto-armed, since people without trackable devices may be home.
- **Freeze / leak guardian** — an automation triggered by moisture sensors or low temperature that
  can close the water shutoff valve and alert.
- **Garage-left-open / doors-unlocked-at-night** watch — a native automation on the door/lock sensors
  plus a time condition, notifying (and optionally acting) when the condition holds.
- **Energy guardian** — an automation on whole-home monitor anomalies; EV-charging cost / peak-rate
  avoidance via rate-based conditions.
- **Camera/security triage (vision)** — the authored automation triggers on a detection sensor, pulls
  a live snapshot, and hands it to Cooper via `conversation.process`. Cooper *looks*: "real visitor
  vs. delivery vs. a cat vs. nothing?" and describes what it actually sees, so the alert reflects
  reality rather than a raw sensor trip.
- **"Away till Monday — watch the place and make it look lived-in"** — two pieces Cooper writes:
  (1) a native **presence-simulation script** that drives lights/TV/blinds along learned routines +
  dusk, varied day to day (not a robotic loop) and winding down at a believable bedtime; and (2) an
  **intruder-watch automation** gated on the away window that escalates real anomalies to critical
  alerts. Both reference native HA time/presence conditions, so they stand down on their own when the
  window ends. (Smarter than a fixed "vacation mode" scene, and fully visible in your UI.)
- **Delivery alerts** — a detection-triggered automation that calls Cooper to confirm a real drop-off
  before notifying you.
- **Pet / elderly inactivity** detection — an automation on inactivity timers/sensors that alerts when
  expected motion doesn't happen.

## Do / one-shot

Reversible actions Cooper just **does** in the moment, and timed sequences it writes as a **native
script**.

- **"Movie night"** — TVs + receiver + lights + shades + do-not-disturb, done on the spot.
- **"Make it cozy"** — interpret time/weather/who's-home into a lighting + climate scene, applied now.
- **"Wind down for bed"** — lights, locks, climate setback, arm.
- **"Clean the pool" / "run the pump for 10 minutes"** — Cooper writes a **script** that runs the
  pump/filter for the duration and then turns it off (and can verify) — a real timed sequence HA owns,
  not a fire-and-forget action.
- **"Water the garden if it won't rain"** — a script that checks the weather forecast and runs
  irrigation only if needed (smarter than a fixed schedule).

## Conversational / informational

Answered live, in the conversation — no rule authored, just look and reply.

- "Is everything okay at home?" (status synthesis)
- "Why is the office cold?" (diagnose: window open? schedule? vent?)
- "When did everyone get home?" (presence history)
- "What's using so much power right now?" (energy analysis)
- "Did anyone come to the door today?" (camera/motion event summary)
- "What's on my calendar — should I leave now?" (calendars + travel-time)
- …plus general-knowledge assistant tasks.

## Proactive (things you ask Cooper to set up)

Cooper has no built-in proactive engine. Instead, you **ask it to set up a recurring native
automation** that triggers on a schedule or condition and calls Cooper to compose and send the
notification.

- **Morning briefing** — "set up a 7am briefing" → an automation triggered at 7am that calls Cooper to
  compose weather, calendar, overnight events, attention items, and energy, then notifies you.
- **Seasonal freeze warnings** — an automation on a forecast/temperature condition that warns you to
  "protect the pipes/pool tonight."
- **Leave-soon reminders** — an automation that combines calendar + travel time and pings you when
  it's time to go.
- **Device-health nudges** — an automation on low-battery / sensor-offline / humidifier-out-of-water
  conditions.
- **Energy** — a weekly-report automation; EV charging-cost optimization on rate conditions.

Alerts carry an agent-chosen urgency (normal / high / **critical** — critical bypasses
Do-Not-Disturb).

## How you invoke them

Just **say it to Assist** — Cooper is your conversation agent, so the request goes straight to it. It
acts and speaks the reply, or (for setup requests) authors the native rule and confirms. The only
endpoint is `POST /ask`, used by the integration to relay your message; there's no separate goal API.

## Patterns, not a fixed list

The catalog isn't fixed firmware. A new use-case is a **new request Cooper turns into a native HA
rule** — a new automation or script, written into the home's own engine where you can see and edit it.
Cooper supplies the judgment (reading sensors, looking at cameras, composing alerts); Home Assistant
supplies the durable running. New capabilities are new *requests*, not new host code — and what Cooper
builds stays inspectable in your own Automations UI.
