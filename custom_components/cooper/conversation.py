"""Cooper as a Home Assistant conversation agent.

Each utterance is forwarded straight to the add-on's /ask endpoint and the reply is spoken.
This replaces the old two-layer bridge (stock LLM agent + Ask Cooper script + input_text mailboxes):
one brain, direct request/response, with per-conversation memory for follow-ups.
"""

from __future__ import annotations

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import ulid as ulid_util

from .api import CooperApi, CooperApiError
from .const import DOMAIN, HISTORY_TURNS, MAX_CONVERSATIONS


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Register the Cooper conversation agent."""
    api: CooperApi = hass.data[DOMAIN][config_entry.entry_id]
    async_add_entities([CooperConversationEntity(config_entry, api)])


def _new_conversation_id() -> str:
    """A fresh conversation id, tolerant of HA util renames."""
    new = getattr(ulid_util, "ulid_now", None) or ulid_util.ulid
    return new()


class CooperConversationEntity(conversation.ConversationEntity):
    """Conversation agent backed by the Cooper guardian add-on."""

    _attr_has_entity_name = True
    _attr_name = "Cooper"

    def __init__(self, entry: ConfigEntry, api: CooperApi) -> None:
        self._entry = entry
        self._api = api
        self._attr_unique_id = entry.entry_id
        # conversation_id -> list[{"role","text"}], so follow-ups ("turn it off") have context.
        self._history: dict[str, list[dict[str, str]]] = {}

    @property
    def supported_languages(self) -> list[str] | str:
        return MATCH_ALL

    async def async_process(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult:
        conv_id = user_input.conversation_id or _new_conversation_id()
        history = self._history.get(conv_id, [])
        # Forward WHO/WHERE this came from so the brain can default "ping me" to the caller's own
        # phone (no guessing) and know who's talking. HA carries both on the conversation input.
        device_id = getattr(user_input, "device_id", None)
        user_id = user_input.context.user_id if user_input.context else None

        # Prefer the STREAMING path: emit the agent's progress to HA's chat log as it works, so a long
        # turn gives running feedback and the voice pipeline gets something to speak before it times
        # out. If anything about the (version-sensitive) streaming API fails, fall back to a single
        # synchronous reply so the agent never breaks.
        result: conversation.ConversationResult | None = None
        reply: str | None = None
        try:
            result, reply = await self._stream(user_input, conv_id, history, device_id, user_id)
        except Exception as err:  # noqa: BLE001 - any streaming failure must degrade, not crash
            _LOGGER.debug("Cooper streaming unavailable, falling back to sync: %s", err)
            result = None

        if result is None:
            try:
                reply = await self._api.ask(
                    user_input.text, conv_id, history, device_id=device_id, user_id=user_id
                )
            except CooperApiError as err:
                reply = f"I can't reach the Cooper guardian right now ({err})."
            response = intent.IntentResponse(language=user_input.language)
            response.async_set_speech(reply)
            result = conversation.ConversationResult(response=response, conversation_id=conv_id)

        if reply:  # remember this turn (the answer, not the progress narration) and prune old ones
            history = [
                *history,
                {"role": "user", "text": user_input.text},
                {"role": "assistant", "text": reply},
            ][-HISTORY_TURNS:]
            self._history[conv_id] = history
            if len(self._history) > MAX_CONVERSATIONS:
                for stale in list(self._history)[:-MAX_CONVERSATIONS]:
                    self._history.pop(stale, None)
        return result

    async def _stream(
        self,
        user_input: conversation.ConversationInput,
        conv_id: str,
        history: list[dict[str, str]],
        device_id: str | None,
        user_id: str | None,
    ) -> tuple[conversation.ConversationResult, str | None]:
        """Stream the agent's progress into HA's chat log. Returns (result, final_reply).

        Imports the chat-log streaming helpers lazily so an unsupported HA version simply raises and
        the caller falls back to the synchronous path.
        """
        from homeassistant.components import conversation as conv
        from homeassistant.helpers import chat_session

        final: list[str] = []

        async def deltas():
            yield {"role": "assistant"}
            async for ev in self._api.ask_stream(
                user_input.text, conv_id, history, device_id, user_id
            ):
                kind = ev.get("type")
                if kind == "step" and ev.get("text"):
                    yield {"content": f"{ev['text']} "}
                elif kind == "final":
                    text = ev.get("reply") or ""
                    final.append(text)
                    if text:
                        yield {"content": text}

        with (
            chat_session.async_get_chat_session(self.hass, conv_id) as session,
            conv.async_get_chat_log(self.hass, session, user_input) as chat_log,
        ):
            async for _content in chat_log.async_add_delta_content_stream(
                self.entity_id, deltas()
            ):
                pass
            result = conv.async_get_result_from_chat_log(user_input, chat_log)
        return result, (final[0] if final else None)
