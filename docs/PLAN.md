# Build plan

Approach: build the **voice front-end and guardian agent in parallel**; autonomy =
**act on safe / confirm risky**; develop on a convenient host first, run production on a
**LAN-local home server**.

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
2. **Web search — MANDATORY gate for adoption.** The phone assistant can't be switched off the
   stock cloud assistant until Claude can answer live web queries. Add a `web_search` tool:
   - *Route A (fast):* a `rest_command`/`script` calling a search API (Tavily / Brave) exposed to
     the conversation agent.
   - *Route B (best):* route Assist to a custom Claude backend with Anthropic's native `web_search`
     server-tool (also unifies the brain with Track B's guardian agent).
   Needs a dedicated search-API key.
3. Tune Claude's system prompt: house context, personality, the curated live-entity surface.
4. Curate intents/scripts for common commands (the fast path).
5. *(optional, later)* voice satellite + "Jarvis" wake word for hands-free.

## Track B — Guardian agent (service)

1. **Core skeleton** — repo + Docker; goal registry; Claude tool-use loop with HA tools; SQLite;
   the tiered guardrail framework; `/healthz`; **observe-mode default**.
2. **Vertical slice — pool "do-goal"** — interpret "clean the pool" → find the pool pump → run a
   cleaning cycle → **verify** → report. Proves the whole chain end-to-end.
3. **Watch loop — "keep an eye"** — WS event subscription + heartbeat, baseline capture, anomaly
   judgment, two-way confirm for risky actions. The showpiece.
4. **Proactive layer** — morning briefing + a couple of guardians (freeze/leak, garage-open).

## Then

- Run Track B on the **LAN-local home server** for production reliability.
- Retire the off-the-shelf assistant room by room as Jarvis earns trust.

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
