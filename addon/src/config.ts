import { readFileSync, existsSync } from "node:fs";

/** Config resolves from the HA add-on options file (/data/options.json) when running as an
 *  add-on, else from env vars when running as a plain Docker container on another host. */
export interface Config {
  anthropicKey: string;
  model: string;
  searchProvider: "none" | "brave" | "tavily";
  searchKey: string;
  observeMode: boolean;
  heartbeatSeconds: number;
  notifyTargets: string[];
  haBaseUrl: string; // REST base, e.g. http://supervisor/core/api
  haWsUrl: string;   // websocket, e.g. ws://supervisor/core/websocket
  haToken: string;
}

export function loadConfig(): Config {
  const opts: Record<string, unknown> = existsSync("/data/options.json")
    ? JSON.parse(readFileSync("/data/options.json", "utf8"))
    : {};
  const get = (k: string, env: string, def = "") =>
    (opts[k] as string) ?? process.env[env] ?? def;

  // Add-on: talk to HA via the supervisor proxy with SUPERVISOR_TOKEN.
  // Standalone: set HA_URL + HA_TOKEN.
  const supervisor = process.env.SUPERVISOR_TOKEN;
  const haUrl = process.env.HA_URL?.replace(/\/$/, "");
  const haBaseUrl = supervisor ? "http://supervisor/core/api" : `${haUrl}/api`;
  const haWsUrl = supervisor
    ? "ws://supervisor/core/websocket"
    : `${haUrl!.replace(/^http/, "ws")}/api/websocket`;
  const haToken = supervisor ?? process.env.HA_TOKEN ?? "";

  return {
    anthropicKey: get("anthropic_api_key", "ANTHROPIC_API_KEY"),
    model: get("model", "MODEL", "claude-sonnet-4-5"),
    searchProvider: (get("search_provider", "SEARCH_PROVIDER", "none") as Config["searchProvider"]),
    searchKey: get("search_api_key", "SEARCH_API_KEY"),
    observeMode: (opts.observe_mode as boolean) ?? process.env.OBSERVE_MODE !== "false",
    heartbeatSeconds: Number(opts.heartbeat_seconds ?? process.env.HEARTBEAT_SECONDS ?? 600),
    notifyTargets: (opts.notify_targets as string[]) ?? [],
    haBaseUrl,
    haWsUrl,
    haToken,
  };
}
