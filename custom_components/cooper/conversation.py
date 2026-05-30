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

        try:
            reply = await self._api.ask(user_input.text, conv_id, history)
        except CooperApiError as err:
            reply = f"I can't reach the Cooper guardian right now ({err})."

        # Remember this turn (capped) and prune old conversations.
        history = [
            *history,
            {"role": "user", "text": user_input.text},
            {"role": "assistant", "text": reply},
        ][-HISTORY_TURNS:]
        self._history[conv_id] = history
        if len(self._history) > MAX_CONVERSATIONS:
            for stale in list(self._history)[:-MAX_CONVERSATIONS]:
                self._history.pop(stale, None)

        response = intent.IntentResponse(language=user_input.language)
        response.async_set_speech(reply)
        return conversation.ConversationResult(
            response=response, conversation_id=conv_id
        )
