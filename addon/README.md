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
- `POST /goal {"text": "...", "type": "watch"|"do", "expires"?, "run_at"?, "on_arrival"?}` — register
  a goal. Watch/expiry/arrival triggers are also inferred from the text.
- `DELETE /goal/:id` · `DELETE /task/:id` — cancel a watch-goal or a scheduled task.

**Voice bridge:** on first run the add-on self-provisions a bridge — it creates two `input_text`
helpers (a request and a response) + an **"Ask Cooper"** script and exposes it to Assist. The script
hands the request to the guardian, then **waits briefly (~9s) for Cooper's reply** and returns it, so
the assistant can speak quick answers inline; longer tasks time out with "On it — I'll notify you"
and Cooper pushes the result. The script is re-written on every start, so updates apply automatically.
(Uninstalling leaves the helpers/script behind — delete them manually for a clean removal.)

**Required manual step — add this routing instruction to your conversation agent's prompt**
(Settings → Devices & Services → your Anthropic Conversation agent → Instructions). Without it the
phone won't reliably hand agentic requests to the guardian:

```
For anything needing watching/monitoring, presence simulation, scheduling a timed sequence
(e.g. sprinklers/irrigation across zones), camera vision, or any multi-step task, call the
"Ask Cooper" script with the user's full request as `goal`.

CRITICAL: you MUST actually CALL the "Ask Cooper" script in this turn. NEVER say "handed it to
Cooper", "Cooper will do it", or "you'll get a notification" unless you actually invoked the
script — if you only describe it, nothing happens. When unsure, call it.

The script returns a "reply" — speak it back to the user verbatim (don't add to it). For quick
requests that's Cooper's actual answer; for longer tasks it's an acknowledgement and Cooper
notifies the result when done.

Only handle simple one-shot device control and direct questions yourself.
```

Then by voice: *"Cooper, is the garage closed?"* gets a spoken answer back; *"Cooper, make it look
like someone's home"* is acknowledged and the guardian acts and notifies the result.

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
