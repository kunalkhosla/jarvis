import WebSocket from "ws";
import type { Config } from "./config.js";

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

  /** POST to an HA config endpoint (e.g. /config/script/config/<id>) — used for self-provisioning. */
  postConfig = (path: string, body: unknown) => this.rest(path, { method: "POST", body: JSON.stringify(body) });

  // ---- Native HA automations (Cooper authors these; HA's engine runs them) ----
  /** Create or replace an automation by id, then reload so it's live. `config` is the automation
   *  body (alias, trigger, condition?, action, mode?). HA stores it in automations.yaml. */
  async upsertAutomation(id: string, config: Record<string, unknown>): Promise<void> {
    await this.rest(`/config/automation/config/${id}`, { method: "POST", body: JSON.stringify(config) });
    await this.callService("automation", "reload");
  }
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
