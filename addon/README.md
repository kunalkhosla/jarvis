# Cooper Guardian (HA add-on)

The brain of a routing agent — an isolated Docker container that runs on the HA box (LAN-local,
survives WAN outages). You talk to it in plain language; it routes each request with judgment, acts
on your home, sees through your cameras, and for anything ongoing it authors a native HA automation
that HA runs itself.

## What it does
- **Claude tool-use loop** (`src/agent.ts`). For each request it *routes*: answer a question (read
  tools), take a reversible action (`call_service`), ask Yes/No first for a risky one, or — for
  anything durable, ongoing, scheduled, or recurring — **author a native HA automation or script**
  that HA owns and runs. Cooper isn't a watch engine; it's the author and the judgment callback.
- **Tools:** `get_live_context` (entities tagged with area + device_class), `get_home_map`
  (areas → entities), `get_history`, `call_service` (guardrailed), `look_at_camera` (vision — sees
  live snapshots), `get_forecast` (HA's local weather, not a web lookup), `notify` (attaches a camera
  photo + agent-chosen priority: normal/high/critical), `create_automation` / `list_automations` /
  `delete_automation`, `create_script` / `list_scripts` / `delete_script`, `create_counter` (for
  "N times then stop"), `web_search` (native), `finish`.
- **Authored rules call back to judgment.** The smart step inside an authored automation runs
  `conversation.process` against the `conversation.cooper` agent — so a native HA trigger fires fast,
  and Cooper only weighs in when there's a decision to make. Lifecycle (today / tonight / N-times) is
  expressed as native HA conditions plus counter helpers, with the rule self-disabling when it's done.
- **Tiered guardrails** (`src/guardrails.ts`): auto / confirm / never — applied both to direct
  actions and to the actions *inside* an authored rule, vetted at authoring time. A deterministic
  validator checks that every entity and service referenced by a rule actually exists before it's
  saved. See `../docs/GUARDRAILS.md`.
- **Observe-mode default**: logs *intended* device actions and takes none until trusted (alerts still
  fire — that's how it talks to you).
- **Kill-switch**: `input_boolean.cooper_pause` halts all action.
- **Self-reaping**: one-shot rules that can no longer fire are cleaned up automatically.
- **Cost guard**: camera-watching is event-driven (one snapshot per look, never live video), capped
  per hour/day with token accounting in `/healthz`.
- **Caller-aware**: the integration forwards `device_id`/`user_id`, so "ping me" targets the caller's
  own phone. Replies are token-streamed.

## Control surface
- `GET /healthz` — ok, observe-mode flag, paused flag, live budget / token usage.
- `POST /ask {"text": "...", "session_id": "...", "history"?: [{"role","text"}], "device_id"?, "user_id"?, "stream"?}`
  → `{"reply"}` (or an NDJSON token stream when `"stream": true`). One conversation turn — routes the
  request, runs synchronously, returns the spoken reply. This is what the Cooper conversation
  integration calls; `session_id` carries in-chat confirmation continuity.

That's the whole surface.

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
| `model` | `MODEL` | default `claude-sonnet-4-5` |
| `observe_mode` | `OBSERVE_MODE` | `true` until trusted (device actions logged, not taken) |
| `max_llm_calls_per_hour` | `MAX_LLM_CALLS_PER_HOUR` | cost cap (default 30) |
| `max_llm_calls_per_day` | `MAX_LLM_CALLS_PER_DAY` | cost cap (default 250) |
| `notify_targets` | — | HA `notify.*` services for alerts |

As an add-on, HA access uses `SUPERVISOR_TOKEN` automatically. Standalone (local dev): set `HA_URL`
+ `HA_TOKEN`. **No secrets are committed** — keys come from add-on options / env only.
