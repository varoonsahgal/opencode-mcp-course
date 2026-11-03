// The 2026 desk's ops board: everything the server sees, redrawn on every event. Pure presentation.
//   npx tsx desk2026.ts           -> the board
//   npx tsx desk2026.ts --plain   -> one log line per event (also when not a TTY)
export type Run = { id: string; user: string; service: string; version: string; step: number; total: number; label: string; state: "running" | "passed" | "failed" | "cancelled" };
export type Desk = {
  services: Record<string, { version: string; deployed_by: string; at: string }>;
  freeze: null | { by: string; reason: string; at: string };
  preflights: Run[];
};
export type Stats = { legacy: number; modern: number; inputRequired: number; tampered: number; listeners: number; cacheTtl: string };

const BOARD = process.stdout.isTTY && !process.argv.includes("--plain");
const color = BOARD && !process.env.NO_COLOR;
const paint = (code: string) => (s: unknown) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [bold, dim, red, green, yellow, cyan, magenta, alarm] = ["1", "2", "31", "32", "33", "36", "35", "1;97;48;5;24"].map(paint);
const pad = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n - 1) + "…" : t.padEnd(n); };
const hhmmss = (d = new Date()) => d.toTimeString().slice(0, 8);

const feed: string[] = [];
let getState: () => { desk: Desk; stats: Stats } = () => ({ desk: { services: {}, freeze: null, preflights: [] }, stats: { legacy: 0, modern: 0, inputRequired: 0, tampered: 0, listeners: 0, cacheTtl: "0 ms" } });
export function attach(fn: typeof getState) { getState = fn; }

export function event(kind: "http" | "rpc" | "call" | "ok" | "refused" | "write" | "notify" | "auth" | "info" | "era", text: string) {
  const tint = { http: dim, rpc: cyan, call: bold, ok: green, refused: red, write: yellow, notify: magenta, auth: red, info: dim, era: cyan }[kind];
  const width = (process.stdout.columns || 120) - 10;
  const line = `${dim(hhmmss())} ${tint(text.length > width ? text.slice(0, width - 1) + "…" : text)}`;
  if (!BOARD) { console.log(`${hhmmss()} ${kind.padEnd(7)} ${text}`); return; }
  feed.push(line);
  if (feed.length > 200) feed.shift();
  draw();
}

const bar = (step: number, total: number, width = 20) => { const full = Math.round((step / total) * width); return "█".repeat(full) + "░".repeat(width - full); };

export function draw() {
  if (!BOARD) return;
  const { desk, stats } = getState();
  const rows = process.stdout.rows || 40;
  const out: string[] = [];
  out.push(`${bold("release desk · 2026-07-28 wire")} ${dim("· createMcpHandler, no sessions · http://127.0.0.1:" + (process.env.PORT ?? 8792) + "/mcp")}   ${dim(hhmmss())}`);
  out.push(desk.freeze ? alarm(` ❄  FREEZE by ${desk.freeze.by}: ${desk.freeze.reason} `) : green(" ● deploys open "));
  out.push("");
  out.push(`${bold("requests")}  ${dim("legacy (initialize, 2025)")} ${stats.legacy}   ${dim("modern (envelope, 2026)")} ${cyan(stats.modern)}   ${dim("input_required")} ${magenta(stats.inputRequired)}   ${dim("tampered")} ${stats.tampered ? red(stats.tampered) : 0}   ${dim("listen streams open")} ${stats.listeners ? green(stats.listeners) : 0}   ${dim("tools/list ttl")} ${stats.cacheTtl}`);
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
  out.push(dim("─".repeat(Math.min(process.stdout.columns || 100, 110))));
  const room = Math.max(3, rows - out.length - 1);
  out.push(...feed.slice(-room));
  process.stdout.write("\x1b[H" + out.join("\x1b[K\n") + "\x1b[K\x1b[J");
}

export function start(onExit: () => void) {
  if (!BOARD) return;
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const bye = () => { process.stdout.write("\x1b[?25h\x1b[?1049l"); console.error("release desk (2026) stopped"); onExit(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  process.stdout.on("resize", draw);
  setInterval(draw, 1000).unref();
  draw();
}
