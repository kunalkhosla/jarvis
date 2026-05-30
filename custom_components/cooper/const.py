"""Constants for the Cooper conversation integration."""

DOMAIN = "cooper"

CONF_URL = "url"
CONF_TOKEN = "token"

# Generic default — the add-on host-maps 8099. NO LAN IP here (this repo is public);
# the user points it at their own host in the config flow.
DEFAULT_URL = "http://homeassistant.local:8099"

# How many recent turns (user+assistant lines) to send back as conversation context.
HISTORY_TURNS = 12
# Cap on how many distinct conversations we keep history for (prevents unbounded growth).
MAX_CONVERSATIONS = 64
