# Migrating from automations

**Should you move all your automations into Cooper? No — and that's the point.**

Automations and an agent are good at *opposite* things. The goal isn't to replace your automations;
it's to (1) **keep** the deterministic reflexes as automations, (2) **collapse** the brittle,
condition-heavy ones that were really *judgment in disguise* into a sentence you tell Cooper, and
(3) **wire** the two together — a fast local trigger handing off to Cooper when a decision is needed.

## Keep as automations — deterministic reflexes

If it's a fixed rule that must fire instantly, every time, even if the internet (or the LLM) is
down, it belongs in an automation. These run constantly and an LLM would only make them slower,
costlier, and less reliable:

- Time/sun-scheduled lighting (on at sunset, off at a set time)
- Recurring equipment schedules (pump/filter cycles, irrigation windows)
- Scheduled security arm/disarm
- Equipment safety timers and auto-off
- Threshold safety reactions that must be instant (close the awning on high wind)
- Simple `motion → light`, volume caps, low-tank/low-battery notifications

> A light turning on at sunset doesn't need a brain. Don't pay a network round-trip and a few cents
> to decide something a `IF sunset THEN on` rule nails every time.

## Move to Cooper — judgment, context, vision, language

These are the automations that grew a tangle of `IF`s because they were trying to *reason*. They
get shorter, smarter, and more robust as goals you state in plain language:

- **Camera triage** — "describe motion and notify" becomes *look, classify (delivery / known /
  unknown / animal), pick urgency, correlate cameras*, instead of pinging on every wobble.
- **Presence simulation / vacation mode** — a fixed light-shuffle scene → a lived-in pattern that
  follows dusk and your routines, varies day to day, and **stands down when you're actually home**
  rather than on a guessed clock.
- **Commute / leave-by reminders** — calendar + live traffic + judgment about when to leave.
- **"Is everything okay at home?"** — one question that composes an answer from live state + a
  glance at the cameras, instead of a web of sensor rules.
- **Arrival prep** — "prepare the home for my arrival" as a task that fires on real proximity, not a
  blind timer that's wrong the moment traffic changes.

## Wire them together — the hybrid pattern

The strongest setups use both: a **deterministic automation as the trigger**, Cooper as the
**decision**.

- `motion detected` (instant local trigger) → Cooper looks at the camera and decides if it's worth
  an alert, and how urgent.
- `smoke/CO detected` → keep the deterministic safety automation (HVAC off, alert) **and** let
  Cooper augment it: identify the area, escalate with a photo, narrate what's happening.

## Rule of thumb

> **Reflex → automation. Judgment → Cooper. Trigger on the reflex, decide with the agent.**

If you can write the rule as `IF this THEN that` and never want it to think, leave it an automation.
If you keep adding `AND`s and `OR`s trying to capture "...but only when it actually matters," that's
the signal it wants to be a Cooper goal instead.
