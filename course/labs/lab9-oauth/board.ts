// The authorization server's board: registered clients, live tokens with their expiry, and every
// request. Pure presentation; auth-server.ts calls the exported functions.
export type ClientRow = { client_id: string; client_name: string; redirect_uris: string[]; how: "dynamic" | "pre-registered"; at: number };
export type TokenRow = { jti: string; user: string; scope: string; aud: string; client_id: string; exp: number; refreshed: number };
export type Stats = { codes: number; tokens: number; refreshes: number; denied: number; reuse: number };

const BOARD = process.stdout.isTTY && !process.argv.includes("--plain");
const color = BOARD && !process.env.NO_COLOR;
const paint = (code: string) => (s: unknown) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [bold, dim, red, green, yellow, cyan, magenta] = ["1", "2", "31", "32", "33", "36", "35"].map(paint);
const pad = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n - 1) + "…" : t.padEnd(n); };
const hhmmss = (d = new Date()) => d.toTimeString().slice(0, 8);

const feed: string[] = [];
let getState: () => { clients: ClientRow[]; tokens: TokenRow[]; stats: Stats } = () => ({ clients: [], tokens: [], stats: { codes: 0, tokens: 0, refreshes: 0, denied: 0, reuse: 0 } });
export function attach(fn: typeof getState) { getState = fn; }

export function event(kind: "http" | "register" | "login" | "code" | "token" | "refresh" | "denied" | "info", text: string) {
  const tint = { http: dim, register: cyan, login: bold, code: yellow, token: green, refresh: magenta, denied: red, info: dim }[kind];
  const width = (process.stdout.columns || 120) - 10;
  const line = `${dim(hhmmss())} ${tint(text.length > width ? text.slice(0, width - 1) + "…" : text)}`;
  if (!BOARD) { console.log(`${hhmmss()} ${kind.padEnd(8)} ${text}`); return; }
  feed.push(line);
  if (feed.length > 200) feed.shift();
  draw();
}

export function draw() {
  if (!BOARD) return;
  const { clients, tokens, stats } = getState();
  const rows = process.stdout.rows || 40, now = Math.floor(Date.now() / 1000);
  const out: string[] = [];
  out.push(`${bold("authorization server")} ${dim("· issuer http://127.0.0.1:" + (process.env.AS_PORT ?? 8791) + " · login page /authorize · tokens /token")}   ${dim(hhmmss())}`);
  out.push(`${dim("codes")} ${stats.codes}  ${dim("tokens")} ${green(stats.tokens)}  ${dim("refreshes")} ${magenta(stats.refreshes)}  ${dim("denied")} ${stats.denied ? red(stats.denied) : 0}  ${dim("refresh reuse caught")} ${stats.reuse ? red(stats.reuse) : 0}`);
  out.push("");
  out.push(bold("clients") + dim("  (who may ask for tokens, and where codes may be sent back)"));
  if (!clients.length) out.push(dim("  none registered yet"));
  for (const c of clients) out.push(`  ${cyan(pad(c.client_id, 22))} ${pad(c.client_name, 24)} ${dim(c.how)}  ${dim(c.redirect_uris.join(" "))}`);
  out.push("");
  out.push(bold("access tokens") + dim("  (live ones; a token is a bearer: whoever holds it, is it)"));
  const live = tokens.filter((t) => t.exp > now - 5).slice(-6);
  if (!live.length) out.push(dim("  none"));
  for (const t of live) { const left = t.exp - now; out.push(`  ${pad(t.user, 6)} ${pad(t.scope, 42)} ${dim("aud " + t.aud.replace("http://127.0.0.1", "…"))}  ${left > 0 ? (left < 20 ? yellow : green)(`${left}s left`) : red("expired")}${t.refreshed ? dim(` · refreshed ×${t.refreshed}`) : ""}  ${dim(t.jti.slice(0, 8))}`); }
  out.push(dim("─".repeat(Math.min(process.stdout.columns || 100, 110))));
  const room = Math.max(3, rows - out.length - 1);
  out.push(...feed.slice(-room));
  process.stdout.write("\x1b[H" + out.join("\x1b[K\n") + "\x1b[K\x1b[J");
}

export function start(onExit: () => void) {
  if (!BOARD) return;
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const bye = () => { process.stdout.write("\x1b[?25h\x1b[?1049l"); console.error("authorization server stopped"); onExit(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  process.stdout.on("resize", draw);
  setInterval(draw, 1000).unref();
  draw();
}
