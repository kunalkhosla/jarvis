import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { HaClient } from "./ha.js";
import { tierFor } from "./guardrails.js";

const L = (m: string) => console.log(`[cooper ${new Date().toISOString()}] ${m}`);

const SYSTEM = `You are Cooper, a home agent for a Home Assistant smart home.
You are given a GOAL and live home state. Reason about what (if anything) to do RIGHT NOW.
- Use get_live_context to read state before acting or answering.
- Act via call_service. Reversible actions (lights/fans/media/climate) run automatically;
  risky ones (locks, alarm, valve, garage/awning close, sirens) require user confirmation —
  call_service will tell you when an action was deferred for confirmation. Never invent entities.
- Only act when the goal warrants it; for watch-goals, often the right answer is "nothing to do".
- Use web_search for live external facts. Use notify to alert the user. Call finish when done.
- REPORT FAITHFULLY from tool results: if call_service returns "[observe]" the action was NOT
  performed (observe mode) — say you *would* do it, never claim you did. If it returns "DEFERRED",
  it needs the user's confirmation — say so, don't claim success.`;

/** Pulls live web facts. Returns text; configured per search_provider. */
async function webSearch(cfg: Config, query: string): Promise<string> {
  if (cfg.searchProvider === "brave") {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
      headers: { "X-Subscription-Token": cfg.searchKey, Accept: "application/json" },
    });
    const j: any = await r.json();
    return (j.web?.results ?? []).slice(0, 5)
      .map((x: any) => `- ${x.title}: ${x.description} (${x.url})`).join("\n") || "no results";
  }
  if (cfg.searchProvider === "tavily") {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: cfg.searchKey, query, max_results: 5, include_answer: true }),
    });
    const j: any = await r.json();
    return j.answer ? `${j.answer}\nSources:\n` + (j.results ?? []).map((x: any) => `- ${x.url}`).join("\n") : "no results";
  }
  return "web search is not configured (set search_provider).";
}

const TOOLS: Anthropic.Tool[] = [
  { name: "get_live_context", description: "Read current live entity states. Optional domains filter.",
    input_schema: { type: "object", properties: { domains: { type: "array", items: { type: "string" } } } } },
  { name: "call_service", description: "Call an HA service. Reversible runs automatically; risky is deferred for confirmation.",
    input_schema: { type: "object", required: ["domain", "service", "reason"],
      properties: { domain: { type: "string" }, service: { type: "string" }, data: { type: "object" }, reason: { type: "string" } } } },
  { name: "web_search", description: "Search the web for live external facts.",
    input_schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } },
  { name: "notify", description: "Send a push notification to the user.",
    input_schema: { type: "object", required: ["message"], properties: { message: { type: "string" } } } },
  { name: "finish", description: "End: summarize what you did / decided.",
    input_schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } } },
];

export async function runGoal(cfg: Config, ha: HaClient, goal: string, extraContext = ""): Promise<string> {
  const anthropic = new Anthropic({ apiKey: cfg.anthropicKey });
  const log: string[] = [];
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `GOAL: ${goal}${extraContext ? `\n\n${extraContext}` : ""}` },
  ];

  L(`▶ goal: ${goal}  (observe=${cfg.observeMode}, model=${cfg.model})`);
  for (let step = 0; step < 12; step++) {
    const res = await anthropic.messages.create({ model: cfg.model, max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages });
    messages.push({ role: "assistant", content: res.content });
    for (const c of res.content) if (c.type === "text" && c.text.trim()) L(`  think: ${c.text.trim().slice(0, 240)}`);
    const toolUses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
    L(`  step ${step}: ${toolUses.length} tool call(s) [stop_reason=${res.stop_reason}]`);
    if (toolUses.length === 0) break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      const a = t.input as any;
      let out = "";
      if (t.name === "finish") { L(`✔ finish: ${a.summary}`); return a.summary; }
      else if (t.name === "get_live_context") {
        const ents = await ha.liveContext(a.domains);
        const compact = ents.map((e) => {
          const at = e.attributes as Record<string, unknown>;
          const o: Record<string, unknown> = { id: e.entity_id, name: at.friendly_name, state: e.state };
          for (const k of ["current_temperature", "temperature", "humidity", "device_class"])
            if (at[k] !== undefined) o[k] = at[k];
          return o;
        });
        out = JSON.stringify(compact).slice(0, 30000);
        L(`    🔍 get_live_context(${(a.domains ?? ["all"]).join(",")}) -> ${compact.length} entities`);
      }
      else if (t.name === "web_search") { L(`    🌐 web_search: ${a.query}`); out = await webSearch(cfg, a.query); }
      else if (t.name === "notify") {
        if (cfg.observeMode) { out = "[observe] would notify: " + a.message; }
        else { for (const tgt of cfg.notifyTargets) await ha.notify(tgt, "Cooper", a.message); out = "notified"; }
        L(`    📲 notify -> ${out}`); log.push(out);
      } else if (t.name === "call_service") {
        const tier = tierFor(a.domain, a.service);
        if (tier === "never") out = "REFUSED (forbidden action)";
        else if (tier === "confirm") out = `DEFERRED for user confirmation: ${a.domain}.${a.service} (${a.reason})`;
        else if (cfg.observeMode) out = `[observe] would call ${a.domain}.${a.service} ${JSON.stringify(a.data ?? {})}`;
        else { await ha.callService(a.domain, a.service, a.data ?? {}); out = "done"; }
        L(`    ⚙ call_service ${a.domain}.${a.service} [${tier}] -> ${out}`); log.push(`${a.domain}.${a.service} [${tier}] -> ${out}`);
      }
      results.push({ type: "tool_result", tool_use_id: t.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }
  L(`■ stopped (max steps)`);
  return "stopped (max steps). actions:\n" + log.join("\n");
}
