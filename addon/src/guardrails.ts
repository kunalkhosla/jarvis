/** Action-tier policy: the agent may auto-run reversible things, must get confirmation for risky
 *  ones, and may never do the forbidden. Keyed by HA "domain.service". See docs/GUARDRAILS.md. */
export type Tier = "auto" | "confirm" | "never";

const CONFIRM = new Set([
  "lock.lock", "lock.unlock",
  "alarm_control_panel.alarm_arm_away", "alarm_control_panel.alarm_arm_home",
  "alarm_control_panel.alarm_arm_night", "alarm_control_panel.alarm_disarm",
  "valve.close_valve", "valve.open_valve",
  "cover.close_cover", // garage/awning close can trap; opening is usually fine
  "siren.turn_on",
]);

const AUTO_DOMAINS = new Set([
  "light", "fan", "media_player", "humidifier", "scene", "switch", "climate", "notify", "tts",
]);

export function tierFor(domain: string, service: string): Tier {
  const key = `${domain}.${service}`;
  if (CONFIRM.has(key)) return "confirm";
  // Outright forbidden: account/config/integration mutation, deletions.
  if (["config", "hassio", "homeassistant"].includes(domain) && /delete|remove|purge/.test(service)) return "never";
  if (AUTO_DOMAINS.has(domain)) return "auto";
  // Irrigation/watering is reversible and low-stakes (you can always stop the water) → auto, so the
  // duration-capable start service can run without a per-zone confirmation. Matched by service name
  // (e.g. start_watering / stop_watering / start_multiple_zone_schedule) so it's not brand-specific.
  if (/(^|_)watering$|zone_schedule$/.test(service)) return "auto";
  // Unknown → be conservative.
  return "confirm";
}
