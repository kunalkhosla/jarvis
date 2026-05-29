# Build plan

Approach: build the **voice front-end and guardian agent in parallel**; autonomy =
**act on safe / confirm risky**; the guardian ships as a **Home Assistant add-on** (LAN-local,
WAN-surviving, no separate host to maintain).

> **Status:** both layers are live. Shipped since this plan was written: camera **vision**, a **cost
> guard**, photo alerts with agent-chosen urgency, **time-boxed / presence-aware / standing**
> watches, **deferred & arrival tasks**, **self-scheduled action sequences** (`schedule_actions`),
> local-forecast weather, the **voice bridge** (talk to the guardian from the phone, self-
> provisioned), and **ElevenLabs/TARS** TTS. See [the changelog](../addon/CHANGELOG.md). This file
> is kept as the original plan + remaining roadmap.

## Phase 0 — Registry hygiene (HARD PREREQUISITE)

An agent on a dirty entity registry hallucinates capabilities and mis-acts. (In early testing, an
automated inventory confidently reported a thermostat brand the home doesn't even own — purely
from a friendly-name guess. A live agent making the same leap would invent or mis-control devices.)
So before anything else:

1. **Audit** — find stale entities (persistently unavailable/unknown) and dead/errored integrations.
2. **Triage** each into **FIX** (real, just misconfigured), **REMOVE** (gone/redundant), or
   **KEEP** (real, just offline) — with the owner confirming, never auto-deleting.
3. **Execute** — repair the FIX integrations; delete REMOVE config entries and purge orphaned
   registry entries.
4. **Re-curate** the exposed entity set so HA's conversation agent (and the guardian's tool
   surface) sees **only real, live, controllable** entities; rebuild a clean capability inventory.

(The home-specific cleanup log lives in the owner's private notes, not in this public repo.)

## Track A — Voice front-end (HA-side, ships fast)

1. Add HA **Anthropic Conversation** integration; set as the conversation agent with
   "prefer local intents, fall back to Claude." Test via the HA app (text + voice).
2. **Web search — DONE.** This was the gate for replacing a stock cloud assistant on a phone.
   Resolved with Anthropic's **native `web_search`** server-tool, enabled directly on the HA
   *Anthropic Conversation* integration — no third-party (Tavily/Brave) key needed.
3. Tune Claude's system prompt: house context, personality, the curated live-entity surface.
4. Curate intents/scripts for common commands (the fast path).
5. *(optional, later)* voice satellite + "Cooper" wake word for hands-free.

## Track B — Guardian agent (Home Assistant add-on)

Packaged as a Docker container with an HA add-on wrapper (`config.yaml` + `Dockerfile`). Runs as an
**add-on on the HA box** — LAN-local, WAN-surviving, no separate host to maintain. (The same image
also runs as a standalone container for local development.)

1. **Core skeleton** — add-on scaffold (`config.yaml`, `Dockerfile`) + agent: goal registry;
   Claude tool-use loop with HA tools (via supervisor token on localhost); SQLite; the tiered
   guardrail framework; `/healthz`; **observe-mode default**.
2. **Vertical slice — pool "do-goal"** — interpret "clean the pool" → find the pool pump → run a
   cleaning cycle → **verify** → report. Proves the whole chain end-to-end.
3. **Watch loop — "keep an eye"** — WS event subscription + heartbeat, baseline capture, anomaly
   judgment, two-way confirm for risky actions. The showpiece.
4. **Proactive layer** — morning briefing + a couple of guardians (freeze/leak, garage-open).

## Then

- Retire the off-the-shelf assistant room by room as Cooper earns trust.
- Expand the proactive layer (briefings, seasonal guardians) and the use-case catalog.

## Verification (per slice)

- **Observe-mode first:** agent reads state + reasons + logs *intended* actions but takes none —
  validate its judgment against reality before granting control.
- **Pool slice:** trigger → confirm the pump turns on (state + logbook) → confirm verify-step + report.
- **Watch slice:** simulate a door-open while "away" → correct alert; confirm benign baseline
  activity does **not** alert; confirm risky actions prompt for confirmation.
- **Guardrails:** attempt a confirm-tier action (e.g. a lock) → must request confirmation, not act.
- **Front-end:** common commands resolve locally (fast); complex ones route to Claude + execute.
- `/healthz` + heartbeat alert so the guardian can't silently die.

## Risks / open items

- **Latency** (LLM path) — mitigated by local fast-path + streaming TTS + Haiku tier.
- **False alarms** — the magic-vs-annoying line; iterate on baselines.
- **Reliability** — guardian must self-monitor; LAN-local hosting is the real fix.
- **Voice hardware** — satellites deferred until the text/app experience is proven.
- **Vendor auth** — some actions (e.g. arming a cloud alarm panel) can be blocked by the vendor's
  own auth flow, independent of this system.
