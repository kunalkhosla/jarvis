/** ANSI colors for the add-on Log tab (HA's log viewer renders ANSI). Keeps each goal evaluation
 *  visually separated — header / reasoning / tool calls / result — so they don't blend together. */
export const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
  think: "\x1b[35m", // magenta — Cooper's reasoning (basic ANSI; 256-color violet wasn't rendered by HA's log viewer)
};

const stamp = () => `${C.gray}[cooper ${new Date().toISOString()}]${C.reset}`;

/** Timestamped log line. */
export const L = (m: string) => console.log(`${stamp()} ${m}`);

/** A bold header line preceded by a rule, to mark the start of a new evaluation. */
export const header = (m: string) =>
  console.log(`\n${C.gray}${"─".repeat(60)}${C.reset}\n${stamp()} ${C.bold}${C.blue}${m}${C.reset}`);
