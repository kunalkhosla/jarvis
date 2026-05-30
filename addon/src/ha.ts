import WebSocket from "ws";
import type { Config } from "./config.js";
import { expectedStateFor } from "./guardrails.js";

export interface EntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

/** Thin Home Assistant client: REST for state/services, WebSocket for live state-change events. */
export class HaClient {
  constructor(private cfg: Config) {}

  private async rest(path: string, init?: RequestInit) {
    const r = await fetch(`${this.cfg.haBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.haToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!r.ok) throw new Error(`HA ${path} -> ${r.status} ${await r.text()}`);
    return r.status === 200 ? r.json() : null;
  }

  getStates = (): Promise<EntityState[]> => this.rest("/states");

  /** Read ONE entity's current state (cheaper than getStates when you only need a single value, e.g.
   *  the kill-switch). Returns null if it doesn't exist (404). */
  async getState(entityId: string): Promise<EntityState | null> {
    try { return await this.rest(`/states/${entityId}`); } catch { return null; }
  }

  /** State history for `entityIds` over [startMs, endMs] — HA's period endpoint, one chronological
   *  array per entity ({state, last_changed}, full attributes on the first point). For "what happened"
   *  questions (get_live_context is current-state only). significant_changes_only drops attribute noise. */
  async getHistory(entityIds: string[], startMs: number, endMs: number): Promise<EntityState[][]> {
    if (!entityIds.length) return [];
    const start = new Date(startMs).toISOString();
    const q = `filter_entity_id=${encodeURIComponent(entityIds.join(","))}&end_time=${encodeURIComponent(new Date(endMs).toISOString())}&minimal_response&significant_changes_only`;
    const d = await this.rest(`/history/period/${start}?${q}`);
    return (d as EntityState[][]) ?? [];
  }

  /** HA's configured location/timezone (the ground truth for any location-based reasoning).
   *  Cached — it doesn't change at runtime. */
  private _config: Record<string, unknown> | null = null;
  async config(): Promise<Record<string, unknown>> {
    return (this._config ??= await this.rest("/config"));
  }

  /** Household presence entities (person.*). */
  async persons(): Promise<EntityState[]> {
    return (await this.getStates()).filter((s) => s.entity_id.startsWith("person."));
  }

  /** A compact, agent-friendly snapshot — drops noise, keeps live controllable entities. */
  async liveContext(domains?: string[]): Promise<EntityState[]> {
    const all = (await this.getStates()) as EntityState[];
    return all.filter(
      (s) =>
        !["unavailable", "unknown"].includes(s.state) &&
        (!domains || domains.includes(s.entity_id.split(".")[0])),
    );
  }

  callService = (domain: string, service: string, data: Record<string, unknown> = {}) =>
    this.rest(`/services/${domain}/${service}`, { method: "POST", body: JSON.stringify(data) });

  /** Every registered service as a Set of "domain.service" — so an authored rule can be checked for
   *  hallucinated service calls (e.g. a notify target that doesn't exist) before it's saved. Cached. */
  private _services: Set<string> | null = null;
  async services(): Promise<Set<string>> {
    if (this._services) return this._services;
    const s = new Set<string>();
    try {
      const data = (await this.rest("/services")) as Array<{ domain: string; services: Record<string, unknown> }>;
      for (const d of data) for (const svc of Object.keys(d.services ?? {})) s.add(`${d.domain}.${svc}`);
    } catch { /* services optional */ }
    this._services = s;
    return s;
  }

  /** Provision a counter helper (HA `counter.*`) so an authored rule can count occurrences across
   *  separate trigger fires ("alert me N times then stop") — repeat.index is loop-only and can't.
   *  Created via the storage-collection WS command (like the kill-switch input_boolean). The entity_id
   *  is counter.<slug-of-name>. Returns the entity_id, or "" on failure. */
  async createCounter(name: string, initial = 0, step = 1): Promise<string> {
    try {
      await this.wsCall({ type: "counter/create", name, initial, step, restore: true });
      const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      return `counter.${slug}`;
    } catch { return ""; }
  }

  /** Render an HA Jinja template (e.g. for area/registry data not exposed over plain REST). */
  async template(t: string): Promise<string> {
    const r = await fetch(`${this.cfg.haBaseUrl}/template`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.haToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ template: t }),
    });
    if (!r.ok) throw new Error(`HA /template -> ${r.status} ${await r.text()}`);
    return r.text();
  }

  /** entity_id → area NAME for every entity that has one (resolved through its device too). Cached for
   *  the process: areas change rarely and this backs the home-map context on every eval. The template
   *  walks all entities and emits [id, area] pairs for those with an area. */
  private _areaMap: Map<string, string> | null = null;
  async areaMap(): Promise<Map<string, string>> {
    if (this._areaMap) return this._areaMap;
    const m = new Map<string, string>();
    try {
      const raw = await this.template(
        "{% set ns = namespace(o=[]) %}" +
        "{% for e in states | map(attribute='entity_id') %}" +
        "{% set a = area_name(e) %}{% if a %}{% set ns.o = ns.o + [[e, a]] %}{% endif %}" +
        "{% endfor %}{{ ns.o | tojson }}",
      );
      for (const [id, area] of JSON.parse(raw) as [string, string][]) m.set(id, area);
    } catch { /* areas optional — fall back to no area annotation */ }
    this._areaMap = m;
    return m;
  }

  /** After a state-changing call, confirm the target entities actually reached the expected state, so
   *  we never claim success on a 200 that didn't take effect (e.g. a lock that won't lock). Returns
   *  ok=true when there's nothing deterministic to verify. Polls briefly to allow for actuation lag. */
  async verifyServiceEffect(service: string, data: Record<string, unknown> = {}): Promise<{ ok: boolean; detail: string }> {
    const expected = expectedStateFor(service);
    const ids = [(data as { entity_id?: unknown })?.entity_id].flat().filter((x): x is string => typeof x === "string");
    if (!expected || !ids.length) return { ok: true, detail: "" };
    const bad: string[] = [];
    for (const id of ids) {
      const final = await this.awaitState(id, expected);
      if (final !== expected) bad.push(`${id} reads "${final}" (wanted "${expected}")`);
    }
    return bad.length ? { ok: false, detail: bad.join("; ") } : { ok: true, detail: `confirmed ${expected}` };
  }

  /** Poll an entity until it reaches `expected` (allowing for device actuation lag), else return its
   *  final observed state. */
  async awaitState(entityId: string, expected: string, tries = 4, gapMs = 1200): Promise<string> {
    let last = "unknown";
    for (let i = 0; i < tries; i++) {
      const st = await this.getState(entityId);
      last = st?.state ?? "unknown";
      if (last === expected) return expected;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
    return last;
  }

  /** POST to an HA config endpoint (e.g. /config/script/config/<id>) — used for self-provisioning. */
  postConfig = (path: string, body: unknown) => this.rest(path, { method: "POST", body: JSON.stringify(body) });

  // ---- Native HA automations (Cooper authors these; HA's engine runs them) ----
  /** Create or replace an automation by id, then reload so it's live. `config` is the automation
   *  body (alias, trigger, condition?, action, mode?). HA stores it in automations.yaml. */
  async upsertAutomation(id: string, config: Record<string, unknown>): Promise<void> {
    await this.rest(`/config/automation/config/${id}`, { method: "POST", body: JSON.stringify(config) });
    await this.callService("automation", "reload");
    // HA derives the entity_id from the ALIAS slug, NOT the config id — so a self-disabling rule's
    // automation.turn_off on automation.<id> would target a nonexistent entity ("Entity not found") and
    // never fire. Force the entity_id to automation.<id> so self-references resolve deterministically.
    try {
      const want = `automation.${id}`;
      const cur = (await this.getStates()).find((s) => s.entity_id.startsWith("automation.") && s.attributes?.id === id);
      if (cur && cur.entity_id !== want) await this.wsCall({ type: "config/entity_registry/update", entity_id: cur.entity_id, new_entity_id: want });
    } catch { /* rename best-effort — self-ref may still mismatch on collision, but the rule is created */ }
  }
  /** Read back an automation's stored config (for the dead-rule reaper / inspection). */
  getAutomationConfig = (id: string): Promise<Record<string, unknown>> => this.rest(`/config/automation/config/${id}`);
  /** Delete an automation's config by id, then reload. */
  async deleteAutomation(id: string): Promise<void> {
    await this.rest(`/config/automation/config/${id}`, { method: "DELETE" });
    await this.callService("automation", "reload");
  }
  /** List automations (entity_id, the config `id` for edit/delete, friendly alias, on/off state). */
  async automations(): Promise<Array<{ entity_id: string; id: string | undefined; alias: string; state: string }>> {
    return (await this.getStates())
      .filter((s) => s.entity_id.startsWith("automation."))
      .map((s) => ({ entity_id: s.entity_id, id: s.attributes?.id as string | undefined, alias: (s.attributes?.friendly_name as string) ?? s.entity_id, state: s.state }));
  }

  // ---- Native HA scripts (Cooper authors these for on-demand timed SEQUENCES; HA runs them) ----
  /** Create or replace a script by id, then reload so it's live. `config` is the script body
   *  (alias, sequence:[...], mode?). Runnable via script.turn_on / script.<id>. */
  async upsertScript(id: string, config: Record<string, unknown>): Promise<void> {
    await this.rest(`/config/script/config/${id}`, { method: "POST", body: JSON.stringify(config) });
    await this.callService("script", "reload");
  }
  /** Delete a script's config by id, then reload. */
  async deleteScript(id: string): Promise<void> {
    await this.rest(`/config/script/config/${id}`, { method: "DELETE" });
    await this.callService("script", "reload");
  }
  /** List scripts (entity_id, the config `id`/object_id for edit/delete, friendly alias, state). */
  async scripts(): Promise<Array<{ entity_id: string; id: string; alias: string; state: string }>> {
    return (await this.getStates())
      .filter((s) => s.entity_id.startsWith("script."))
      .map((s) => ({ entity_id: s.entity_id, id: s.entity_id.split(".")[1], alias: (s.attributes?.friendly_name as string) ?? s.entity_id, state: s.state }));
  }

  /** HA's own weather forecast for the home's exact location. Discovers the weather entity by
   *  DOMAIN (generic — no hardcoded entity names) and returns its forecast list. Beats web search,
   *  which reverse-geocodes coordinates to a nearby town and can be flat wrong. */
  async getForecast(type: "daily" | "hourly" = "daily"): Promise<{ entity: string; forecast: unknown[] } | null> {
    const w = (await this.getStates()).find((s) => s.entity_id.startsWith("weather."));
    if (!w) return null;
    const d = await this.rest(`/services/weather/get_forecasts?return_response`, {
      method: "POST", body: JSON.stringify({ entity_id: w.entity_id, type }),
    });
    const forecast = (d as any)?.service_response?.[w.entity_id]?.forecast ?? [];
    return { entity: w.entity_id, forecast };
  }

  /** Fetch a still JPEG from a camera via HA's camera_proxy, as base64 for Claude vision.
   *  Reolink full-res "*_fluent" streams 500 on snapshot — fall back to the "*_clear" substream. */
  async cameraSnapshot(entityId: string): Promise<{ base64: string; mediaType: "image/jpeg" } | null> {
    const grab = async (id: string): Promise<string | null> => {
      const r = await fetch(`${this.cfg.haBaseUrl}/camera_proxy/${id}`, {
        headers: { Authorization: `Bearer ${this.cfg.haToken}` },
      });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer()).toString("base64");
    };
    let b = await grab(entityId);
    if (!b && entityId.endsWith("_fluent")) b = await grab(entityId.replace(/_fluent$/, "_clear"));
    return b ? { base64: b, mediaType: "image/jpeg" } : null;
  }

  /** Push a notification. `data` is the companion-app data object (image, importance, channel, …)
   *  — e.g. { image: "/api/camera_proxy/camera.x", importance: "high", channel: "alarm_stream" }. */
  notify = (target: string, title: string, message: string, data?: Record<string, unknown>) =>
    this.callService("notify", target.replace(/^notify\./, ""), {
      title, message, ...(data && Object.keys(data).length ? { data } : {}),
    });

  /** One-shot authenticated WebSocket command (auth → send → first result → close). For commands
   *  with no REST equivalent, e.g. creating helpers (`input_text/create`) or exposing entities. */
  wsCall(payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.cfg.haWsUrl);
      let id = 1, done = false;
      const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); try { ws.close(); } catch { /* */ } fn(); } };
      const timer = setTimeout(() => finish(() => reject(new Error("ws timeout"))), 10000);
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: this.cfg.haToken }));
        else if (m.type === "auth_ok") ws.send(JSON.stringify({ id: id++, ...payload }));
        else if (m.type === "result") finish(() => (m.success ? resolve(m.result) : reject(new Error(JSON.stringify(m.error)))));
      });
      ws.on("error", (e) => finish(() => reject(e)));
    });
  }

  /** Subscribe to state_changed events; calls cb(entity_id, newState) on each change. */
  subscribe(cb: (entityId: string, state: EntityState) => void) {
    const ws = new WebSocket(this.cfg.haWsUrl);
    let id = 1;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: this.cfg.haToken }));
      else if (msg.type === "auth_ok")
        ws.send(JSON.stringify({ id: id++, type: "subscribe_events", event_type: "state_changed" }));
      else if (msg.type === "event") {
        const ns = msg.event?.data?.new_state;
        if (ns) cb(ns.entity_id, ns);
      }
    });
    ws.on("close", () => setTimeout(() => this.subscribe(cb), 5000)); // auto-reconnect
    return ws;
  }

  /** Subscribe to a specific HA event type (e.g. mobile_app_notification_action for Yes/No taps). */
  onEvent(eventType: string, cb: (data: Record<string, any>) => void) {
    const ws = new WebSocket(this.cfg.haWsUrl);
    let id = 1;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: this.cfg.haToken }));
      else if (msg.type === "auth_ok") ws.send(JSON.stringify({ id: id++, type: "subscribe_events", event_type: eventType }));
      else if (msg.type === "event") cb(msg.event?.data ?? {});
    });
    ws.on("close", () => setTimeout(() => this.onEvent(eventType, cb), 5000));
    return ws;
  }
}
