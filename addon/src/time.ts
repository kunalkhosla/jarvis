/** Parse an expiry timestamp from a goal's natural-language text, for time-boxed watches like
 *  "keep an eye out until Monday evening" or "watch the backyard for 2 hours". Deterministic and
 *  conservative: only well-known phrasings match; anything ambiguous returns null (open-ended,
 *  Cooper watches until explicitly told to stop). Times are computed in the host's local zone. */
const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const PART_HOUR: Record<string, number> = { morning: 8, noon: 12, afternoon: 15, evening: 19, night: 22 };

function atHour(base: Date, hour: number): number {
  const d = new Date(base);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function parseExpiry(text: string, now: number = Date.now()): number | null {
  const t = text.toLowerCase();
  const ref = new Date(now);

  // "for N minutes/hours/days/weeks"
  const rel = t.match(/\bfor\s+(\d+)\s*(minute|min|hour|hr|day|week)s?\b/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit.startsWith("min") ? 60_000 : unit.startsWith("h") ? 3_600_000 : unit === "day" ? 86_400_000 : 604_800_000;
    return now + n * ms;
  }

  const part = t.match(/\b(morning|noon|afternoon|evening|night)\b/);
  const hour = part ? PART_HOUR[part[1]] : 19; // default to evening

  // "tonight" → tomorrow ~6am
  if (/\btonight\b/.test(t)) return atHour(new Date(now + 86_400_000), 6);

  // "until/till tomorrow [evening]"
  if (/\b(until|till|til)\s+tomorrow\b/.test(t)) return atHour(new Date(now + 86_400_000), hour);

  // "this weekend" → Monday 8am
  if (/\bthis weekend\b/.test(t)) {
    const d = new Date(ref); const add = (8 - d.getDay()) % 7 || 7; // next Monday
    return atHour(new Date(now + add * 86_400_000), 8);
  }

  // "until <weekday> [part]" → next occurrence of that weekday at the part-hour
  const dow = t.match(/\b(until|till|til)\s+(sun|mon|tue|wed|thu|fri|sat)\w*/);
  if (dow) {
    const target = DOW[dow[2]];
    let add = (target - ref.getDay() + 7) % 7;
    if (add === 0) add = 7; // "until Monday" said on a Monday means next Monday
    return atHour(new Date(now + add * 86_400_000), hour);
  }

  return null;
}

/** Detect a deferred-task trigger in a do-goal: a scheduled time and/or "when I arrive home".
 *  Returns { runAt, onArrival } — both falsy means "run now" (a normal immediate do-goal). */
export function parseTrigger(text: string, now: number = Date.now()): { runAt: number | null; onArrival: boolean } {
  const t = text.toLowerCase();
  const onArrival = /\b(when (i|we) (get|am|are|'re)?\s*(home|back)|on (my |our )?arrival|when (i|we) arrive|almost home|nearly home|near(ing)? home|pulling in|on the way home)\b/.test(t);

  let runAt: number | null = null;
  // "in 30 minutes" / "in an hour"  OR  "30 minutes away" / "an hour out"
  const m = t.match(/\b(?:in|after)\s+(\d+|an?)\s*(minute|min|hour|hr)s?\b/) || t.match(/\b(\d+|an?)\s*(minute|min|hour|hr)s?\s+(?:away|out|from home)\b/);
  if (m) {
    const n = /^an?$/.test(m[1]) ? 1 : Number(m[1]);
    runAt = now + n * (m[2].startsWith("h") ? 3_600_000 : 60_000);
  }
  return { runAt, onArrival };
}

/** A STANDING away-watch — recurring: arms whenever everyone leaves, disarms when home, kept
 *  forever. e.g. "keep an eye whenever we're out", "always watch when we're away". */
export function wantsStandingWhileAway(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(whenever|any\s?time|always|every time|each time)\b/.test(t) && /\b(out|away|gone|not home|leave|left)\b/.test(t);
}

/** A one-shot away-watch — stand down (and delete) when the household returns home this time. */
export function wantsPresenceStandDown(text: string): boolean {
  const t = text.toLowerCase();
  if (wantsStandingWhileAway(t)) return false; // standing watches own their own lifecycle
  return /\b(while|when|until|till|til)\b[^.]*\b(out|away|gone|back|home|return|returning|leave|leaving)\b/.test(t)
    || /\b(while away|while out|on vacation|on holiday|out of town|out of the house|until we'?re back|when we get home|when we'?re back)\b/.test(t);
}
