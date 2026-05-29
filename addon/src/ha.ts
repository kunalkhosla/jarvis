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

  notify = (target: string, title: string, message: string) =>
    this.callService("notify", target.replace(/^notify\./, ""), { title, message });

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
}
