# Cooper Guardian (HA add-on)

The goal-driven guardian agent — an isolated Docker container that runs on the HA box (LAN-local,
survives WAN outages). You give it goals in plain language; it watches and acts on your home with
judgment, sees through your cameras, and knows when to ask first.

## What it does
- **Claude tool-use loop** (`src/agent.ts`) with tools: `get_live_context`, `look_at_camera`
  (vision — sees live snapshots), `call_service` (guardrailed), `get_forecast` (HA's local weather,
  not a web lookup), `schedule_actions` (plan a timed sequence — e.g. presence simulation),
  `web_search` (native), `notify` (attaches a camera photo + agent-chosen priority: normal/high/
  critical), `finish`.
- **Watch-goals & do-goals.** Watch-goals react to relevant home events (filtered, debounced) plus
  a heartbeat; do-goals are one-shot tasks. Both run on the same reason → act → verify loop.
- **Time-boxed & presence-aware.** "Watch until Monday evening" auto-stands-down when the window
  ends; "keep an eye while we're out" stands down when everyone's home again (time cap as backstop).
- **Deferred/triggered tasks.** "Prepare the home for my arrival" / "in an hour…" fires on a
  scheduled time or when you actually arrive home.
- **Tiered guardrails** (`src/guardrails.ts`): auto / confirm / never — see `../docs/GUARDRAILS.md`.
- **Observe-mode default**: logs *intended* device actions and takes none until trusted (alerts
  still fire — that's how it talks to you).
- **Cost guard**: camera-watching is event-driven (one snapshot per trigger, never live video),
  capped per hour/day with token accounting in `/healthz`.
- **SQLite persistence**: watch-goals, tasks, and an action log survive restarts.
- **Morning briefing** (optional): a daily proactive summary at `briefing_time`.

## Control surface
- `GET /healthz` — status, active goals, scheduled tasks, live budget.
- `POST /ask {"text": "...", "session_id": "...", "history"?: [{"role","text"}]}` → `{"reply"}` — one
  conversation turn (stop/watch/do routing, runs synchronously, returns the spoken reply). This is what
  the Cooper conversation integration calls; `session_id` carries in-chat confirmation continuity.
- `POST /goal {"text": "...", "type": "watch"|"do", "expires"?, "run_at"?, "on_arrival"?}` — register
  a goal directly. Watch/expiry/arrival triggers are also inferred from the text.
- `DELETE /goal/:id` · `DELETE /task/:id` · `DELETE /sequence/:id` — cancel a watch-goal, scheduled
  task, or pending sequence.

**Talk to Cooper:** install the companion **Cooper conversation integration** (`custom_components/cooper/`
— via HACS as a custom repository, or copy it to `/config/custom_components/`), restart HA, then
**Settings → Devices & Services → Add Integration → Cooper** and point it at this add-on
(`http://homeassistant.local:8099`; the form validates `/healthz`). Finally set **Cooper** as your
Assist **conversation agent** (Settings → Voice assistants). Every utterance then goes straight to the
guardian via `POST /ask` and the assistant speaks the reply — with conversation memory and in-chat
confirmations. No script, no `input_text` mailbox, no routing prompt.

On first run the add-on only self-provisions the **kill-switch** (`input_boolean.cooper_pause`).

> **Migrating from ≤0.22?** The old bridge is gone. Delete the three orphaned helpers manually:
> `script.cooper_watch`, `input_text.cooper_watch_request`, `input_text.cooper_response`. The
> kill-switch stays.

**Optional local fast-path:** to keep simple commands instant, enable Assist's *"prefer handling
commands locally"* and expose your core entities — HA resolves those with its local intent engine and
only falls through to Cooper for conversational, ambiguous, or multi-step requests.

## Config (add-on options; env for standalone dev)
| Option | Env | Notes |
|---|---|---|
| `anthropic_api_key` | `ANTHROPIC_API_KEY` | dedicated project key |
| `model` | `MODEL` | `claude-haiku-4-5` for cheap always-on; a Sonnet model for sharper reasoning |
| `observe_mode` | `OBSERVE_MODE` | `true` until trusted (device actions logged, not taken) |
| `heartbeat_seconds` | `HEARTBEAT_SECONDS` | watch-goal periodic re-check |
| `max_llm_calls_per_hour` | `MAX_LLM_CALLS_PER_HOUR` | cost cap (default 30) |
| `max_llm_calls_per_day` | `MAX_LLM_CALLS_PER_DAY` | cost cap (default 250) |
| `briefing_time` | `BRIEFING_TIME` | local `HH:MM` for the daily briefing (`""` = off) |
| `notify_targets` | — | HA `notify.*` services for alerts |

As an add-on, HA access uses `SUPERVISOR_TOKEN` automatically. Standalone (local dev): set `HA_URL`
+ `HA_TOKEN`. **No secrets are committed** — keys come from add-on options / env only.
