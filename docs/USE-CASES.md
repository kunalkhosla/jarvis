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
- **Camera/security triage** — person detection: "real visitor vs. delivery vs. nothing?"
- **Pet / elderly inactivity** detection.

## Do / task (one-shot agentic)
- **"Clean the pool"** (run the pump/filter cycle, then verify).
- **"Movie night"** — TVs + receiver + lights + shades + do-not-disturb.
- **"Make it cozy"** — interpret time/weather/who's-home into a lighting + climate scene.
- **"Water the garden if it won't rain"** — irrigation + weather forecast (smarter than a fixed
  schedule).
- **"Wind down for bed"** — lights, locks, climate setback, arm.
- **Vacation mode** — adaptive, goal-driven rather than a brittle scene.

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
