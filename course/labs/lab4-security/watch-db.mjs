#!/usr/bin/env node
// watch-db: a live view of team.db, for a second terminal while the agent works.
//
// It polls the database twice a second over a READ-ONLY connection and redraws
// customers (grouped by country) and tickets. When a row disappears it stays on
// screen in red with the time it died, and the header keeps score. Re-seeding
// the database is detected and clears the graveyard.
//
//   usage: node watch-db.mjs [path-to-db]        (default: $TEAMDB_PATH or team.db)
//
import sqlite3 from "node-sqlite3-wasm"; // CommonJS package: default import, then pick Database
const { Database } = sqlite3;
import { existsSync, statSync } from "node:fs";

const DB = process.argv[2] ?? process.env.TEAMDB_PATH ?? "team.db";
const LIVE = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (LIVE ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [red, green, yellow, cyan, dim, bold, inv] = [c("31"), c("32"), c("33"), c("36"), c("2"), c("1"), c("1;30;41")];
const clock = () => new Date().toTimeString().slice(0, 8);
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

let prev = null;          // last snapshot: { customers: Map, tickets: Map, ino }
const dead = new Map();   // "c:9" / "t:106" -> { row, at }
const events = [];        // newest last
let destroyed = 0, flashUntil = 0, flashText = "", lastDelete = "";

function snapshot() {
  if (!existsSync(DB)) return null;
  const db = new Database(DB, { readOnly: true, fileMustExist: true });
  try {
    const customers = new Map(db.all("SELECT id, name, country, plan FROM customers ORDER BY id").map((r) => [r.id, r]));
    const tickets = new Map(db.all("SELECT id, customer_id, subject, status FROM tickets ORDER BY id").map((r) => [r.id, r]));
    return { customers, tickets, ino: statSync(DB).ino };
  } finally { db.close(); }
}

function log(kind, text) {
  events.push({ at: clock(), kind, text });
  if (!LIVE) console.log(`${clock()} ${kind.padEnd(7)} ${text}`);
}

function diff(next) {
  if (!prev) return;
  // seed.ts deletes and re-creates the file: a new inode means a fresh database.
  if (next.ino !== prev.ino) {
    dead.clear(); destroyed = 0; lastDelete = ""; log("reset", `database re-created (seed.ts): ${next.customers.size} customers, ${next.tickets.size} tickets`);
    return;
  }
  const gone = [];
  for (const [id, r] of prev.customers) if (!next.customers.has(id)) { dead.set(`c:${id}`, { row: r, at: clock() }); gone.push(`customer ${id} ${r.name} (${r.country})`); }
  for (const [id, r] of prev.tickets) if (!next.tickets.has(id)) { dead.set(`t:${id}`, { row: r, at: clock() }); gone.push(`ticket #${id}`); }
  for (const g of gone) log("DELETE", g);
  if (gone.length) { destroyed += gone.length; lastDelete = clock(); flashUntil = Date.now() + 6000; flashText = `DELETE DETECTED · ${gone.length} row(s) just vanished`; }
  for (const [id, r] of next.customers) {
    const p = prev.customers.get(id);
    if (!p) log("insert", `customer ${id} ${r.name}`);
    else if (p.plan !== r.plan) log("update", `customer ${id} ${r.name}: plan ${p.plan} → ${r.plan}`);
  }
  for (const [id, r] of next.tickets) {
    const p = prev.tickets.get(id);
    if (p && p.status !== r.status) log("update", `ticket #${id}: ${p.status} → ${r.status}`);
  }
}

function render(s) {
  const out = [];
  const W = Math.min(process.stdout.columns || 100, 110);
  const head = ` TEAM.DB · live · ${clock()} · ${DB}`;
  const score = `rows destroyed: ${destroyed} `;
  const bar = head + " ".repeat(Math.max(1, W - head.length - score.length)) + score;
  out.push(Date.now() < flashUntil ? inv(bar) : destroyed ? red(bold(bar)) : cyan(bold(bar)));
  out.push(Date.now() < flashUntil ? red(bold(` ⚠  ${flashText}`))
    : destroyed ? red(` ⚠  last delete at ${lastDelete} · nobody was asked to confirm`)
    : dim(" read-only connection · polling every 500 ms · ctrl+c to quit"));
  out.push("");
  if (!s) { out.push(yellow(`  ${DB} does not exist yet. Run: npx tsx seed.ts`)); return out; }

  // Customers by country, the living first, then the dead in red.
  const byCountry = new Map();
  for (const r of s.customers.values()) (byCountry.get(r.country) ?? byCountry.set(r.country, { live: [], dead: [] }).get(r.country)).live.push(r);
  for (const [k, d] of dead) if (k[0] === "c") (byCountry.get(d.row.country) ?? byCountry.set(d.row.country, { live: [], dead: [] }).get(d.row.country)).dead.push(d);
  out.push(bold(`  CUSTOMERS  ${s.customers.size} alive`) + (destroyed ? red(`  ·  ${[...dead.keys()].filter((k) => k[0] === "c").length} deleted`) : ""));
  for (const [country, g] of [...byCountry].sort((a, b) => b[1].live.length - a[1].live.length || a[0].localeCompare(b[0]))) {
    const blocks = green("█".repeat(g.live.length * 2)) + red("░".repeat(g.dead.length * 2));
    const room = W - 18 - g.dead.reduce((n, d) => n + d.row.name.length + 4, 0);
    const names = g.live.length ? cut(g.live.map((r) => r.name).join(", "), Math.max(10, room)).trimEnd() : "";
    const graves = g.dead.map((d) => red(`✗ ${d.row.name}`)).join(red(", "));
    out.push(`  ${bold(country)} ${blocks}${" ".repeat(Math.max(1, 9 - (g.live.length + g.dead.length) * 2))}${String(g.live.length).padStart(2)}  ${dim(names)}${names && graves ? "  " : ""}${graves}`);
  }

  out.push("", bold(`  TICKETS  ${[...s.tickets.values()].filter((t) => t.status === "open").length} open`));
  const rows = [...s.tickets.values()].map((t) => ({ t, at: null })).concat([...dead].filter(([k]) => k[0] === "t").map(([, d]) => ({ t: d.row, at: d.at })));
  for (const { t, at } of rows.sort((a, b) => a.t.id - b.t.id)) {
    const who = (s.customers.get(t.customer_id) ?? dead.get(`c:${t.customer_id}`)?.row)?.name ?? "?";
    const line = `  #${t.id}  ${cut(t.subject, Math.max(16, W - 52))}  ${cut(who, 18)}  `;
    if (at) out.push(red(`${line}💀 deleted ${at}`));
    else out.push(t.status === "open" ? line + green("open") : dim(line + "closed"));
  }

  out.push("", bold("  EVENTS"));
  const recent = events.slice(-7);
  if (!recent.length) out.push(dim("  nothing has changed yet. Go ask the agent something."));
  const tint = { DELETE: red, update: yellow, insert: green, reset: cyan };
  for (const e of recent) out.push(`  ${dim(e.at)}  ${tint[e.kind](e.kind.padEnd(6))}  ${e.text}`);
  return out;
}

let lastStamp = "";
function tick() {
  // Only open the database when the file changed: an idle watcher holds no locks.
  let stamp = "";
  try { const st = statSync(DB); stamp = `${st.ino}:${st.mtimeMs}:${st.size}`; } catch {}
  let s = prev;
  if (!stamp) s = null;
  else if (stamp !== lastStamp || !prev) {
    try { s = snapshot(); } catch { return; } // mid-write or mid-seed: try again next tick
    if (s) { diff(s); prev = s; lastStamp = stamp; }
  }
  if (LIVE) process.stdout.write("\x1b[H" + render(s).map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
}

if (LIVE) {
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const bye = () => { process.stdout.write("\x1b[?25h\x1b[?1049l"); process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
} else console.log(`watching ${DB} (plain mode: one line per change)`);
tick();
setInterval(tick, 500);
