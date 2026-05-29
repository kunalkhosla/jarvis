# Repo conventions

**⚠️ THIS REPO IS PUBLIC-BOUND** (it will be made public). Everything committed here must be safe
to publish. When writing or editing anything in this repo:

- **No secrets** — never commit API keys, tokens, passwords, or `.env` files. Use `.env.example`
  with placeholders only.
- **No real network details** — no LAN IPs, ports, internal hostnames, or remote-access URLs.
  Use placeholders like `<ha-host>`, `<home-server>`, `<vps>`.
- **No PII** — no real names (especially children/family), emails, account IDs, phone/device
  names, or serial numbers.
- **No home-security blueprint** — do not enumerate exact camera counts/locations, alarm/lock/
  valve specifics, or occupancy patterns. Describe capabilities *generically* (e.g. "cameras,
  locks, climate, presence"), never as a map of this specific home.
- Keep docs about the **architecture and design** — the reusable, shareable part.

**Where private/home-specific things go instead:** the owner's **private** repos — one for infra
(hosts, network, the actual registry/cleanup log, deploy specifics) and one for the HA config
(entities, secrets template). Anything tied to a specific home belongs there, not in this repo.

If in doubt, generalize — or put it in the private repos.
