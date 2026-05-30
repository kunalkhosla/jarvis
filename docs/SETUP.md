# Setting up Cooper

Cooper has **two pieces** that install separately:

1. **The add-on** (`Cooper Guardian`) — the brain. Runs as a Home Assistant add-on, talks to Claude, and
   reads/controls your home.
2. **The integration** (`Cooper`) — the voice. A small custom integration that makes Cooper an Assist
   conversation agent, so you can just talk to it.

You need both. Plan on ~10 minutes.

---

## Prerequisites

- **Home Assistant OS or Supervised** — the add-on needs the Supervisor. (Container/Core installs can
  run the add-on as a plain Docker container instead — see the bottom of this page.)
- **An Anthropic API key** — from <https://console.anthropic.com>. Make a dedicated key for Cooper so you
  can track spend and revoke it independently.
- **The Home Assistant companion app** on your phone — this is what gives Cooper a `notify.mobile_app_*`
  service to alert you (and a camera to attach photos to). Recommended.
- **HACS** (optional but easiest, for the integration) — <https://hacs.xyz>. You can also install the
  integration by copying files.

---

## 1. Install the add-on (the brain)

1. **Settings → Add-ons → Add-on Store → ⋮ (top-right) → Repositories**.
2. Add: `https://github.com/kunalkhosla/cooper` → **Add** → close.
3. Find **Cooper Guardian** in the store (reload the store with ⋮ → *Check for updates* if it doesn't show
   immediately) → **Install**.

## 2. Configure the add-on

On the add-on's **Configuration** tab:

| Option | What to set |
|---|---|
| `anthropic_api_key` | Your Anthropic key. |
| `model` | Leave as `claude-sonnet-4-5` (good balance of quality and speed). |
| `observe_mode` | **Leave `true` to start.** Cooper *describes* what it would do but takes no real action — the safe way to build trust. Set `false` later to let it act. |
| `notify_targets` | Optional. Your notify services, e.g. `notify.mobile_app_your_phone`. Cooper also auto-targets the phone you're talking from, so this is mainly a fallback. |

**Start** the add-on. On first run it creates a **kill-switch** helper (`input_boolean.cooper_pause`) —
flip that on any time to instantly halt all of Cooper's actions.

> Sanity check: the add-on serves a health endpoint at `http://homeassistant.local:8099/healthz`.

## 3. Install the integration (the voice)

**Via HACS (recommended):**
1. **HACS → ⋮ → Custom repositories** → add `https://github.com/kunalkhosla/cooper`, type **Integration** →
   **Add**.
2. Find **Cooper** → **Download** → pick the latest.
3. **Restart Home Assistant** (required — the integration's code only loads on restart).

**Manual:** copy `custom_components/cooper/` into your `/config/custom_components/` and restart HA.

## 4. Connect the integration to the add-on

1. **Settings → Devices & Services → Add Integration → Cooper**.
2. Point it at the add-on URL: **`http://homeassistant.local:8099`** (or your HA host’s address + `:8099`).

## 5. Make Cooper your assistant

1. **Settings → Voice assistants** → open your pipeline (or create one).
2. Set **Conversation agent → Cooper**.
3. (Voice, optional) Pick your Speech-to-text and Text-to-speech engines. **For snappy spoken replies,
   use a streaming-capable TTS** (e.g. a local **Piper** add-on, or ElevenLabs) — some cloud TTS engines
   buffer the whole reply before speaking, which adds a delay on longer answers.

---

## 6. Try it

Open Assist (the chat bubble in HA, your phone’s assistant, or a voice satellite) and talk normally —
these are exact prompts to start with:

- *"Is it cold in here?"* — answers from live state.
- *"Turn off the kitchen lights."* — acts (or, in observe mode, says what it *would* do).
- *"Did anyone come to the front door this morning?"* — checks history.
- *"Watch the front door tonight and ping me with a photo if someone shows up."* — **writes a real Home
  Assistant automation** that does exactly that, visible in your Automations list.
- *"Unlock the front door."* — a risky action, so it asks you to confirm first.

When you trust it, set **`observe_mode: false`** in the add-on config so it actually acts.

---

## Get the most out of Cooper

Cooper is only as sharp as what it can *see and understand* about your home. A few minutes of
housekeeping makes a real difference in how well it picks the right entities:

1. **Assign your entities to Areas — the big one.** Cooper grounds itself in your Home Assistant
   **areas**: *"watch the backyard"* expands to *every* entity in the Backyard area (cameras, lights,
   sensors). Entities with no area fall back to fuzzy name-matching, which is worse — it can grab the
   wrong sensor. Assign **devices** to areas (Settings → Devices → a device → Area) — that cascades to
   all of the device's entities. Pay special attention to your **outdoor cameras and their
   person/motion sensors**; those drive the security use-cases.
2. **Label cross-area groups.** An area is one room/zone; **Labels** group things that span areas — e.g.
   label all your outdoor cameras `outdoor-camera`, so *"check all the outside cameras"* resolves cleanly.
3. **Clean up dead / unavailable entities.** Stale entities (persistently `unavailable`/`unknown`) and
   dead integrations are noise the agent can trip over. Remove or fix them (Settings → Devices &
   Services → Entities, filter by status) so Cooper only sees real, live, controllable devices.
4. **Use clear friendly names.** Cooper reads friendly names, not entity IDs — and entity IDs often
   *lie* (a zone slugged `zone_5_front` can actually be your side yard). Name things the way you'd say
   them out loud.
5. **Install the companion app on your phones.** It gives Cooper a `notify.mobile_app_*` to alert you, a
   camera photo to attach — and because the app tells Cooper *which* device is talking, *"ping me"* hits
   the phone you're actually on. Make sure notifications are allowed.
6. **Start in observe mode, then let it act.** Keep `observe_mode: true` until you trust its judgment
   (it describes what it *would* do without doing it), then flip to `false`. Keep the kill-switch
   (`input_boolean.cooper_pause`) handy.
7. **Want snappy spoken replies? Use a streaming TTS.** Some cloud TTS engines buffer the whole reply
   before speaking. A local **Piper** add-on (or ElevenLabs) speaks as Cooper streams.
8. **Check its work — it's all visible.** Everything Cooper writes is a normal HA automation/script
   tagged `[Cooper]` in your Automations list. Glance at them, edit them, or just tell Cooper *"that's
   not right, fix it."*

## Safety model (worth knowing)

- **Observe mode** — start here; Cooper takes no real actions, only describes them.
- **Kill-switch** — toggle `input_boolean.cooper_pause` on to halt everything instantly.
- **Tiered actions** — reversible things (lights, climate, media) just happen; risky things (locks,
  alarm, garage, valves) **always ask first**; forbidden things never happen. The same tiers apply to the
  *actions inside* any automation Cooper writes.
- **Self-cleaning** — one-shot rules ("tonight", "3 times then stop") are removed automatically once
  they can no longer fire, so you don't accumulate dead automations.

See [GUARDRAILS.md](GUARDRAILS.md) for the full autonomy model.

---

## Troubleshooting

- **Cooper doesn't answer** — make sure the add-on is **running** and the integration points at the right
  URL (`:8099`). Check `http://homeassistant.local:8099/healthz` returns `{"ok":true,...}`.
- **The add-on disappeared from the store** — reload the Add-on Store (⋮ → *Check for updates*).
- **Integration changes didn't take effect** — you must **restart Home Assistant** after updating it.
- **No voice, just text** — that's your Assist pipeline's **TTS engine**, not Cooper. Use a
  streaming-capable TTS (Piper / ElevenLabs). Cooper streams its reply as it generates it.
- **It made a wrong automation** — just tell it ("that's not right, fix it" / "remove that one"); it can
  edit and delete its own rules. They're all tagged `[Cooper]` in your Automations list.

---

## Running the add-on as a plain Docker container

For Core/Container HA (no Supervisor), run the same image as a normal container and point it at HA with
`HA_URL` + a long-lived `HA_TOKEN` instead of the supervisor token. See [`addon/README.md`](../addon/README.md).
