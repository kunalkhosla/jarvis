/** Cost guard for the LLM. Camera-watch is event-driven (one snapshot per trigger, not live
 *  video), but a busy outdoor camera can still fire often — so cap how many LLM calls Cooper
 *  makes per rolling hour/day and track token usage. Automatic (watch/heartbeat) evals are gated;
 *  user-initiated goals run anyway but still count toward usage. In-memory; resets on restart. */
export interface Usage {
  input_tokens?: number; output_tokens?: number;
  cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
}

export class Budget {
  private callsHour: number[] = [];
  private callsDay: number[] = [];
  inTok = 0;
  outTok = 0;
  cacheWriteTok = 0; // tokens written to cache (~1.25x)
  cacheReadTok = 0;  // tokens served from cache (~0.1x) — the savings
  imgs = 0;

  constructor(private maxPerHour: number, private maxPerDay: number) {}

  private prune(now: number) {
    this.callsHour = this.callsHour.filter((t) => now - t < 3_600_000);
    this.callsDay = this.callsDay.filter((t) => now - t < 86_400_000);
  }

  /** Whether an automatic eval may start. User goals bypass this. */
  canRun(now: number): { ok: boolean; reason?: string } {
    this.prune(now);
    if (this.callsHour.length >= this.maxPerHour) return { ok: false, reason: `hourly LLM cap reached (${this.maxPerHour})` };
    if (this.callsDay.length >= this.maxPerDay) return { ok: false, reason: `daily LLM cap reached (${this.maxPerDay})` };
    return { ok: true };
  }

  recordCall(now: number, usage?: Usage) {
    this.callsHour.push(now);
    this.callsDay.push(now);
    this.inTok += usage?.input_tokens ?? 0;
    this.outTok += usage?.output_tokens ?? 0;
    this.cacheWriteTok += usage?.cache_creation_input_tokens ?? 0;
    this.cacheReadTok += usage?.cache_read_input_tokens ?? 0;
  }

  recordImages(n: number) { this.imgs += n; }

  stats(now: number) {
    this.prune(now);
    return {
      lastHour: this.callsHour.length, maxPerHour: this.maxPerHour,
      lastDay: this.callsDay.length, maxPerDay: this.maxPerDay,
      inputTokens: this.inTok, outputTokens: this.outTok,
      cacheWriteTokens: this.cacheWriteTok, cacheReadTokens: this.cacheReadTok, imagesSeen: this.imgs,
    };
  }
}
