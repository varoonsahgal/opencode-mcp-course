// The gateway's board: every upstream, every quarantined tool, every decision. Pure presentation.
//   npx tsx gateway.ts           -> the board
//   npx tsx gateway.ts --plain   -> one log line per event (also when not a TTY)
export type UpstreamRow = { name: string; status: "starting" | "up" | "down"; tools: number; quarantined: number; server: string };
export type QuarantineRow = { key: string; reason: string };
export type Stats = { calls: number; allowed: number; denied: number; quarantined: number; redactions: number; audited: number };

const BOARD = process.stdout.isTTY && !process.argv.includes("--plain");
const color = BOARD && !process.env.NO_COLOR;
const paint = (code: string) => (s: unknown) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [bold, dim, red, green, yellow, cyan, magenta] = ["1", "2", "31", "32", "33", "36", "35"].map(paint);
const pad = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n - 1) + "…" : t.padEnd(n); };
const hhmmss = (d = new Date()) => d.toTimeString().slice(0, 8);

const feed: string[] = [];
let getState: () => { upstreams: UpstreamRow[]; quarantine: QuarantineRow[]; stats: Stats } = () => ({ upstreams: [], quarantine: [], stats: { calls: 0, allowed: 0, denied: 0, quarantined: 0, redactions: 0, audited: 0 } });
export function attach(fn: typeof getState) { getState = fn; }

export function event(kind: "info" | "up" | "call" | "allow" | "deny" | "quarantine" | "redact" | "audit" | "pin", text: string) {
  const tint = { info: dim, up: cyan, call: bold, allow: green, deny: red, quarantine: magenta, redact: yellow, audit: dim, pin: cyan }[kind];
  if (!BOARD) { console.log(`${hhmmss()} ${kind.padEnd(10)} ${text}`); return; }
  const width = (process.stdout.columns || 120) - 10;
  feed.push(`${dim(hhmmss())} ${tint(text.length > width ? text.slice(0, width - 1) + "…" : text)}`);
  if (feed.length > 200) feed.shift();
  draw();
}

export function draw() {
  if (!BOARD) return;
  const { upstreams, quarantine, stats } = getState();
  const rows = process.stdout.rows || 40;
  const out: string[] = [];
  out.push(`${bold("MCP gateway")} ${dim("· one door for every server · http://127.0.0.1:" + (process.env.PORT ?? 8800) + "/mcp")}   ${dim(hhmmss())}`);
  out.push(`${dim("calls")} ${stats.calls}  ${dim("allowed")} ${green(stats.allowed)}  ${dim("denied")} ${stats.denied ? red(stats.denied) : 0}  ${dim("quarantined tools")} ${stats.quarantined ? magenta(stats.quarantined) : 0}  ${dim("redactions")} ${stats.redactions ? yellow(stats.redactions) : 0}  ${dim("audit lines")} ${stats.audited}`);
  out.push("");
  out.push(bold("upstreams") + dim("  (stdio children of the gateway; their credentials never leave this process)"));
  for (const u of upstreams) out.push(`  ${cyan(pad(u.name, 9))} ${u.status === "up" ? green("● up  ") : u.status === "down" ? red("✗ down") : dim("… ")} ${pad(u.server, 22)} ${dim(`${u.tools} tools`)}${u.quarantined ? magenta(`  ${u.quarantined} quarantined`) : ""}`);
  if (quarantine.length) {
    out.push("");
    out.push(bold("quarantine") + dim("  (hidden from every agent until a lead reviews it)"));
    for (const q of quarantine.slice(-4)) out.push(`  ${magenta(pad(q.key, 28))} ${dim(pad(q.reason, Math.max(20, (process.stdout.columns || 120) - 34)))}`);
  }
  out.push(dim("─".repeat(Math.min(process.stdout.columns || 100, 110))));
  const room = Math.max(3, rows - out.length - 1);
  out.push(...feed.slice(-room));
  process.stdout.write("\x1b[H" + out.join("\x1b[K\n") + "\x1b[K\x1b[J");
}

export function start(onExit: () => void) {
  if (!BOARD) return;
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const bye = () => { process.stdout.write("\x1b[?25h\x1b[?1049l"); console.error("gateway stopped"); onExit(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  process.stdout.on("resize", draw);
  setInterval(draw, 1000).unref();
  draw();
}
