// The release desk's ops board: a full-screen view of everything the MCP server sees,
// redrawn on every event. Pure presentation; no MCP in here. server.ts calls the
// exported functions; you never need to edit this file.
//
//   npx tsx server.ts           -> the board, in this terminal
//   npx tsx server.ts --plain   -> one log line per event instead (also when not a TTY)

export type Session = { id: string; user: string; client: string; protocol: string; since: number; streams: number };
export type Run = { id: string; user: string; service: string; version: string; step: number; total: number; label: string; state: "running" | "passed" | "failed" | "cancelled" };
export type Desk = {
  services: Record<string, { version: string; deployed_by: string; at: string }>;
  freeze: null | { by: string; reason: string; at: string };
  preflights: Run[];
};

const BOARD = process.stdout.isTTY && !process.argv.includes("--plain");
const color = BOARD && !process.env.NO_COLOR;
const paint = (code: string) => (s: unknown) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [bold, dim, red, green, yellow, cyan, magenta, alarm] = ["1", "2", "31", "32", "33", "36", "35", "1;97;48;5;24"].map(paint);
const pad = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n - 1) + "…" : t.padEnd(n); };
const hhmmss = (d = new Date()) => d.toTimeString().slice(0, 8);

const feed: string[] = [];
const tally = { http: 0, calls: 0, refused: 0, writes: 0, notifications: 0, unauthorized: 0 };
let getState: () => { desk: Desk; sessions: Session[] } = () => ({ desk: { services: {}, freeze: null, preflights: [] }, sessions: [] });

export function attach(fn: typeof getState) { getState = fn; }

/** One line in the event feed. kind picks the colour. */
export function event(kind: "http" | "rpc" | "call" | "ok" | "refused" | "write" | "notify" | "auth" | "info", text: string) {
  if (kind === "http") tally.http++;
  if (kind === "call") tally.calls++;
  if (kind === "refused") tally.refused++;
  if (kind === "write") tally.writes++;
  if (kind === "notify") tally.notifications++;
  if (kind === "auth") tally.unauthorized++;
  const tint = { http: dim, rpc: cyan, call: bold, ok: green, refused: red, write: yellow, notify: magenta, auth: red, info: dim }[kind];
  const line = `${dim(hhmmss())} ${tint(text)}`;
  if (!BOARD) { console.log(`${hhmmss()} ${kind.padEnd(7)} ${text}`); return; }
  feed.push(line);
  if (feed.length > 200) feed.shift();
  draw();
}

function bar(step: number, total: number, width = 20) {
  const full = Math.round((step / total) * width);
  return "█".repeat(full) + "░".repeat(width - full);
}

export function draw() {
  if (!BOARD) return;
  const { desk, sessions } = getState();
  const rows = process.stdout.rows || 40;
  const out: string[] = [];
  out.push(`${bold("release desk")} ${dim("· Streamable HTTP MCP server · http://127.0.0.1:" + (process.env.PORT ?? 8790) + "/mcp")}   ${dim(hhmmss())}`);
  out.push(desk.freeze ? alarm(` ❄  FREEZE by ${desk.freeze.by}: ${desk.freeze.reason} `) : green(" ● deploys open "));
  out.push("");
  out.push(bold("sessions") + dim("  (one per connected MCP client; the token decides who it is)"));
  if (!sessions.length) out.push(dim("  none yet: start opencode with DESK_TOKEN set"));
  for (const s of sessions) out.push(`  ${cyan(pad(s.user, 7))} ${pad(s.client, 18)} ${dim("protocol " + s.protocol)}  ${dim("session " + s.id.slice(0, 8))}  ${s.streams ? green("◉ listening") : dim("○ no stream")}`);
  out.push("");
  out.push(bold("services"));
  for (const [id, s] of Object.entries(desk.services)) out.push(`  ${pad(id, 9)} ${pad(s.version, 8)} ${dim(`deployed by ${s.deployed_by} at ${s.at}`)}`);
  const runs = desk.preflights.slice(-3);
  if (runs.length) {
    out.push("");
    out.push(bold("preflight checks"));
    for (const r of runs) {
      const tint = { running: cyan, passed: green, failed: red, cancelled: yellow }[r.state];
      out.push(`  ${pad(r.user, 7)} ${pad(`${r.service}@${r.version}`, 16)} ${tint(bar(r.step, r.total))} ${pad(`${r.step}/${r.total}`, 5)} ${tint(r.state === "running" ? r.label : r.state)}`);
    }
  }
  out.push("");
  out.push(`${dim("http")} ${tally.http}  ${dim("tool calls")} ${tally.calls}  ${dim("refused")} ${tally.refused ? red(tally.refused) : 0}  ${dim("writes")} ${tally.writes ? yellow(tally.writes) : 0}  ${dim("notifications")} ${tally.notifications}  ${dim("401s")} ${tally.unauthorized}`);
  out.push(dim("─".repeat(Math.min(process.stdout.columns || 100, 100))));
  const room = Math.max(3, rows - out.length - 1);
  out.push(...feed.slice(-room));
  process.stdout.write("\x1b[H" + out.join("\x1b[K\n") + "\x1b[K\x1b[J");
}

export function start(onExit: () => void) {
  if (!BOARD) return;
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const bye = () => { process.stdout.write("\x1b[?25h\x1b[?1049l"); console.error(`release desk stopped (${tally.calls} tool calls, ${tally.writes} writes, ${tally.refused} refused)`); onExit(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  process.stdout.on("resize", draw);
  setInterval(draw, 1000).unref();
  draw();
}
