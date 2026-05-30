"""Thin async client for the Cooper add-on's HTTP control surface."""

from __future__ import annotations

import logging

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)


class CooperApiError(Exception):
    """Raised when the add-on cannot be reached or returns an error."""


class CooperApi:
    """Talks to the Cooper Guardian add-on (POST /ask, GET /healthz)."""

    def __init__(self, hass: HomeAssistant, url: str, token: str = "") -> None:
        self._session = async_get_clientsession(hass)
        self._url = url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"} if token else {}

    async def healthz(self) -> bool:
        """Return True if the add-on answers /healthz with 200."""
        try:
            async with self._session.get(
                f"{self._url}/healthz",
                headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                return resp.status == 200
        except (aiohttp.ClientError, TimeoutError) as err:
            _LOGGER.debug("Cooper /healthz failed: %s", err)
            return False

    async def ask(
        self,
        text: str,
        session_id: str,
        history: list[dict[str, str]] | None = None,
        device_id: str | None = None,
        user_id: str | None = None,
    ) -> str:
        """Send one utterance to Cooper and return the spoken reply."""
        payload = {"text": text, "session_id": session_id, "history": history or []}
        if device_id:
            payload["device_id"] = device_id
        if user_id:
            payload["user_id"] = user_id
        try:
            async with self._session.post(
                f"{self._url}/ask",
                json=payload,
                headers=self._headers,
                # A real agentic turn can take a while; streaming (later) improves the UX.
                timeout=aiohttp.ClientTimeout(total=90),
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    raise CooperApiError(f"/ask -> {resp.status} {body[:200]}")
                data = await resp.json()
                return data.get("reply", "")
        except (aiohttp.ClientError, TimeoutError) as err:
            raise CooperApiError(str(err)) from err
