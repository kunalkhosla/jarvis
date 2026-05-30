# Status & roadmap

Cooper is a **routing agent over Home Assistant**, packaged as a **Home Assistant add-on**
(LAN-local, WAN-surviving, no separate host to maintain) and registered as the HA conversation
agent. It runs on the HA box itself; the same image also runs as a standalone container for local
development.

The shape is a **router**, not a watch loop. For each request, Cooper decides how to handle it:

- **answer** — informational, no action.
- **act (reversible)** — do it now (lights, media, scenes…), within guardrails.
- **confirm (risky)** — propose, then act only on an explicit yes (locks, valves, anything
  destructive or hard to undo).
- **author** — when the ask is *standing* ("whenever…", "every morning…", "if the door's open
  for 10 min…"), Cooper writes a **native HA automation or script** rather than holding state
  itself.

This replaces the original v1 design (a heartbeat watch-loop with SQLite goals/tasks,
self-scheduled action sequences, and a morning-briefing engine). That engine has been **removed**.
The store is now just an **audit log**. See [the changelog](../addon/CHANGELOG.md) for the history.

## Phase 0 — Registry hygiene (HARD PREREQUISITE)

This matters *more* now, not less: Cooper **grounds on the HA registry** — areas, `device_class`,
and a `get_home_map` view of the home. A clean, well-area'd registry is what lets it act correctly.
An agent on a dirty registry hallucinates capabilities and mis-acts. (In early testing, an
automated inventory confidently reported a thermostat brand the home doesn't even own — purely from
a friendly-name guess. A live agent making the same leap would invent or mis-control devices.)

So before granting an agent control:

1. **Audit** — find stale entities (persistently unavailable/unknown) and dead/errored integrations.
2. **Triage** each into **FIX** (real, just misconfigured), **REMOVE** (gone/redundant), or
   **KEEP** (real, just offline) — with the owner confirming, never auto-deleting.
3. **Execute** — repair the FIX integrations; delete REMOVE config entries and purge orphaned
   registry entries.
4. **Re-curate & ground** — assign every entity to an **area**, **label cameras**, and re-curate
   the exposed set so Cooper sees only real, live, controllable entities with the structure it
   needs to reason about the home.

(The home-specific cleanup log lives in the owner's private notes, not in this public repo.)

## Shipped (v2)

- **Native authoring** — `create_automation` / `create_script` write real HA automations and
  scripts, so standing requests become first-class HA objects (visible, editable, durable) instead
  of agent-held state.
- **Judgment callback** — authored rules can call back via `conversation.process` to wake Cooper at
  trigger time ("look at the camera and decide"), so a rule's *condition* can be an LLM judgment,
  not just a numeric threshold.
- **Grounding** — areas + `device_class` + `get_home_map` give Cooper a structured view of the
  home to route and target actions.
- **Tiered guardrails** — auto / confirm / never, applied to **both** direct actions **and** the
  actions an authored rule would take.
- **Validation** — a deterministic entity/service validator (does this entity/service exist?) plus
  an advisory "does this rule actually match the stated intent?" check before authoring.
- **Confirmations** — in-chat and push **Yes/No** for confirm-tier actions.
- **Kill-switch + observe mode** — a hard stop, and a mode where Cooper reasons and logs intended
  actions but takes none.
- **Caller-aware notify** — replies and confirmations target the device you're talking from.
- **Token-streamed replies** — responses stream as they generate.
- **Counter primitive** — `create_counter` for "do X up to N times, then stop" patterns.
- **Lifecycle cleanup** — automatic removal of one-shot authored rules once they can no longer fire.

## Roadmap (next, honest + optional)

- **More helper-creation surface** — beyond counters (e.g. other HA helpers) for richer authored
  patterns.
- **Smarter lifecycle verification** — confirm authored rules actually fired / had the intended
  effect, and reconcile drift.
- **Local-TTS streaming voice** — low-latency spoken replies via a streaming local TTS engine.
- **Model tiering** — cheaper/faster models for simple routes, stronger ones for authoring and
  judgment, to control cost.
- **Authoring-pattern docs** — a small catalog of "say this → Cooper authors that" recipes.

## Risks / open items

- **Latency** (LLM path) — mitigated by **token-streaming** replies; the perceived wait is the
  first token, not the full response.
- **Voice timing** — spoken latency depends on the **TTS engine streaming** as text arrives; a
  non-streaming engine bottlenecks here regardless of the LLM.
- **Reliability** — Cooper must not silently die; running as a **LAN-local add-on** on the HA box
  (WAN-surviving, no extra host) is the real fix.
- **Vendor auth** — some actions (e.g. arming a cloud alarm panel) can be blocked by the vendor's
  own auth flow, independent of this system.
