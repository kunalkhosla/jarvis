"""Config flow for the Cooper conversation integration."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .api import CooperApi
from .const import CONF_TOKEN, CONF_URL, DEFAULT_URL, DOMAIN


class CooperConfigFlow(ConfigFlow, domain=DOMAIN):
    """Single-step flow: point Cooper at the add-on and validate /healthz."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].rstrip("/")
            token = user_input.get(CONF_TOKEN, "")
            await self.async_set_unique_id(url)
            self._abort_if_unique_id_configured()
            api = CooperApi(self.hass, url, token)
            if await api.healthz():
                return self.async_create_entry(
                    title="Cooper", data={CONF_URL: url, CONF_TOKEN: token}
                )
            errors["base"] = "cannot_connect"

        schema = vol.Schema(
            {
                vol.Required(CONF_URL, default=DEFAULT_URL): str,
                vol.Optional(CONF_TOKEN, default=""): str,
            }
        )
        return self.async_show_form(
            step_id="user", data_schema=schema, errors=errors
        )
