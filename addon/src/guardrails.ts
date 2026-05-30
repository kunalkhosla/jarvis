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
  // Running a script/automation is as safe as the actions inside it. Cooper's OWN authored scripts are
  // already vetted all-auto at create time (vetConfig), so requiring a second confirm just to RUN one
  // is pointless friction — and a user's pre-existing script/automation is their own intent.
  "script", "automation",
]);

/** The state a target entity should reach after a given service, so a caller can read the entity back
 *  and confirm the action actually took effect instead of trusting a 200 (e.g. a lock that won't lock).
 *  Keyed by the bare service name (no domain). Null/absent = nothing deterministic to verify. */
export const EXPECTED_STATE: Record<string, string> = {
  turn_on: "on", turn_off: "off",
  lock: "locked", unlock: "unlocked",
  open_cover: "open", close_cover: "closed",
  open_valve: "open", close_valve: "closed",
  alarm_arm_away: "armed_away", alarm_arm_home: "armed_home",
  alarm_arm_night: "armed_night", alarm_disarm: "disarmed",
};

/** Resulting state to verify for a `domain.service` (or bare service), or null if not verifiable. */
export function expectedStateFor(service: string): string | null {
  return EXPECTED_STATE[service.includes(".") ? service.split(".").pop()! : service] ?? null;
}

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

/** Recursively collect every HA service call ("domain.service") referenced anywhere in an automation
 *  or script config — under either the legacy `service:` key or the newer `action:` key (HA ≥2024.10).
 *  Only string values shaped like domain.service count, so the top-level `action:` array (a list of
 *  steps) is walked through, not mistaken for a service string. */
export function collectServices(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) { for (const v of node) collectServices(v, out); return out; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === "service" || k === "action") && typeof v === "string" && /^[a-z_]+\.[a-z0-9_]+$/.test(v)) out.push(v);
      else collectServices(v, out);
    }
  }
  return out;
}

/** Every entity_id referenced anywhere in a config — under any `entity_id` key (string or list) and
 *  inside any `/api/camera_proxy/<entity>` image path. Used to reject authored rules that reference
 *  entities that don't exist (a deterministic check the LLM can't fake its way past). */
export function collectEntityIds(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) { for (const v of node) collectEntityIds(v, out); return out; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "entity_id") for (const id of [v].flat()) { if (typeof id === "string" && /^[a-z_]+\.[a-z0-9_]+$/.test(id)) out.add(id); }
      else collectEntityIds(v, out);
    }
    return out;
  }
  if (typeof node === "string") { const m = node.match(/\/api\/camera_proxy\/([a-z_]+\.[a-z0-9_]+)/); if (m) out.add(m[1]); }
  return out;
}

/** Lint authored notify actions: the mobile-app companion attaches a photo from `data.image`
 *  ("/api/camera_proxy/<cam>"); a bare `data.camera` key is silently ignored. Returns warnings. */
export function lintNotifyPhotos(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) { for (const n of node) lintNotifyPhotos(n, out); return out; }
  if (node && typeof node === "object") {
    const o = node as Record<string, any>;
    const act = o.service ?? o.action;
    if (typeof act === "string" && act.startsWith("notify.")) {
      const data = o.data?.data ?? o.data;
      if (data && typeof data === "object" && "camera" in data && !("image" in data))
        out.push(`${act} uses data.camera, which the app ignores — attach a photo with data.image:"/api/camera_proxy/<camera_entity>" instead`);
    }
    for (const v of Object.values(o)) lintNotifyPhotos(v, out);
  }
  return out;
}

/** Vet the actions INSIDE an authored automation/script before it's written. An authored rule runs
 *  natively in HA with no human in the loop, so a risky action it performs would bypass the per-call
 *  confirm flow entirely — hence we tier every service it references and let the caller refuse to
 *  author anything that isn't fully auto-tier. Returns the worst tier plus the offending services. */
export function vetConfig(config: unknown): { worst: Tier; never: string[]; confirm: string[] } {
  const never: string[] = [], confirm: string[] = [];
  for (const s of [...new Set(collectServices(config))]) {
    const [domain, ...rest] = s.split(".");
    const t = tierFor(domain, rest.join("."));
    if (t === "never") never.push(s);
    else if (t === "confirm") confirm.push(s);
  }
  return { worst: never.length ? "never" : confirm.length ? "confirm" : "auto", never, confirm };
}
