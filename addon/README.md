# Cooper Guardian (HA add-on)

The goal-driven guardian agent (Layer 2) as a Home Assistant add-on — an isolated Docker
container that runs on the HA box (LAN-local, survives WAN outages). The **same image** runs as a
standalone container on a home server later.

## What it is
- **Claude tool-use loop** (`src/agent.ts`) with tools: `get_live_context`, `call_service`
  (guardrailed), `web_search`, `notify`, `finish`.
- **Tiered guardrails** (`src/guardrails.ts`): auto / confirm / never — see `../docs/GUARDRAILS.md`.
- **HA client** (`src/ha.ts`): REST + WebSocket state-change subscription.
- **Observe-mode default**: logs *intended* actions, takes none, until trusted.
- Control surface (`src/index.ts`): `GET /healthz`, `POST /goal {text}` to run a goal now.

## Config (add-on options, or env for standalone)
| Option | Env | Notes |
|---|---|---|
| `anthropic_api_key` | `ANTHROPIC_API_KEY` | dedicated project key |
| `model` | `MODEL` | e.g. `claude-sonnet-4-5` |
| `search_provider` | `SEARCH_PROVIDER` | `none` \| `brave` \| `tavily` |
| `search_api_key` | `SEARCH_API_KEY` | search provider key |
| `observe_mode` | `OBSERVE_MODE` | `true` until trusted |
| `heartbeat_seconds` | `HEARTBEAT_SECONDS` | watch-goal tick |
| `notify_targets` | — | HA notify services |

As an add-on, HA access uses `SUPERVISOR_TOKEN` automatically. Standalone: set `HA_URL` + `HA_TOKEN`.
**No secrets are committed** — keys come from add-on options / env only.

## Status
v0 skeleton: do-goals via `POST /goal` work; watch-goal event engine + SQLite persistence are TODO.
