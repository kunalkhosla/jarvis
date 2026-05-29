# Use-case catalog

What a Claude + Home Assistant agent can do, given a typical well-instrumented home (climate,
cameras with person detection, locks, alarm, irrigation, pool, whole-home energy monitoring,
calendars, weather, presence, media players, a water shutoff valve).

## Guardian / watch (judgment-based monitoring)
- **"Keep an eye while I'm out"** — motion/door/camera anomaly vs. a learned baseline → contextual
  alert ("a door opened, no one's home").
- **"Look after the house / the kids are home"** — comfort (climate + fans + dusk lights), safety
  (smoke/CO/door watch), suppress risky devices, periodic check-ins. Engaged manually only —
  never auto-armed, since people without trackable devices may be home.
- **Freeze / leak guardian** — moisture sensors + low temperature + the water shutoff valve.
- **Garage-left-open / doors-unlocked-at-night** watch.
- **Energy guardian** — whole-home monitor anomalies; EV-charging cost / peak-rate avoidance.
- **Camera/security triage (vision)** — a detection sensor trips → Cooper pulls a live snapshot and
  *looks*: "real visitor vs. delivery vs. a cat vs. nothing?" and describes what it actually sees.
- **"Away till Monday — watch the place and make it look lived-in"** — a *time-boxed* watch + smart
  presence simulation: lights/TV/blinds follow learned routines + dusk, varied day to day (not a
  robotic loop), winding down at a believable bedtime; escalates real anomalies to critical alerts;
  stands down automatically when the window ends. (Smarter than a fixed "vacation mode" scene.)
- **Pet / elderly inactivity** detection.

## Do / task (one-shot agentic)
- **"Clean the pool"** (run the pump/filter cycle, then verify).
- **"Movie night"** — TVs + receiver + lights + shades + do-not-disturb.
- **"Make it cozy"** — interpret time/weather/who's-home into a lighting + climate scene.
- **"Water the garden if it won't rain"** — irrigation + weather forecast (smarter than a fixed
  schedule).
- **"Wind down for bed"** — lights, locks, climate setback, arm.
- **Vacation mode** — adaptive, goal-driven rather than a brittle scene.
- **"Prepare the home for my arrival" / "in an hour, warm up the house"** — a *deferred* task that
  fires on a scheduled time **or when you actually arrive** (proximity/arrival), not a blind timer
  that's wrong when traffic changes; comfortable climate + entry lights if it's dark, reversible only.

## Conversational / informational
- "Is everything okay at home?" (status synthesis)
- "Why is the office cold?" (diagnose: window open? schedule? vent?)
- "When did everyone get home?" (presence history)
- "What's using so much power right now?" (energy analysis)
- "Did anyone come to the door today?" (camera/motion event summary)
- "What's on my calendar — should I leave now?" (calendars + travel-time)
- …plus general-knowledge assistant tasks.

## Proactive (agent initiates)
- **Morning briefing** — weather, calendar, overnight events, attention items, energy.
- **Device-health nudges** — low battery, sensor offline, humidifier out of water.
- **Seasonal** — first-freeze warning ("protect the pipes/pool tonight").
- **Energy** — weekly report; EV charging-cost optimization.
- **Leave-soon** reminder from calendar + travel time.

## Patterns, not a fixed list
Watch-goals and do-goals run on the same engine (reason → act/alert → remember). New use-cases are
mostly new *prompts/goals*, not new code — that's the point of an agent vs. brittle automations.
