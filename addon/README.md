# Cooper Guardian (HA add-on)

The goal-driven guardian agent — an isolated Docker container that runs on the HA box (LAN-local,
survives WAN outages). You give it goals in plain language; it watches and acts on your home with
judgment, sees through your cameras, and knows when to ask first.

## What it does
- **Claude tool-use loop** (`src/agent.ts`) with tools: `get_live_context`, `look_at_camera`
  (vision — sees live snapshots), `call_service` (guardrailed), `web_search` (native), `notify`
  (attaches a camera photo + agent-chosen priority), `finish`.
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
- `POST /goal {"text": "...", "type": "watch"|"do", "expires"?, "run_at"?, "on_arrival"?}` — register
  a goal. Watch/expiry/arrival triggers are also inferred from the text.
- `DELETE /goal/:id` · `DELETE /task/:id` — cancel a watch-goal or a scheduled task.

Or just talk to it from the HA voice assistant (it bridges via an `input_text` helper).

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
