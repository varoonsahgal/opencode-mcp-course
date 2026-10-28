#!/usr/bin/env node
// wiretap-view: watch the MCP conversation live, as a sequence diagram in your terminal.
//
// It follows the log that mcp-tap.mjs writes and turns every JSON-RPC line into one
// readable row: who spoke, which method, how long the answer took, and the part of
// the payload that matters. Run it in a second terminal while OpenCode works.
//
//   usage: node wiretap-view.mjs <logfile> [--once]
//   e.g.   node wiretap-view.mjs mcp-traffic.log          (follows, like tail -f)
//          node wiretap-view.mjs mcp-traffic.log --once   (renders what is there and exits)
//
import { existsSync, openSync, readSync, statSync, closeSync } from "node:fs";

const file = process.argv[2];
const once = process.argv.includes("--once");
if (!file) { console.error("usage: node wiretap-view.mjs <logfile> [--once]"); process.exit(2); }

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { dim: paint(2), bold: paint(1), red: paint(31), green: paint(32), yellow: paint(33), magenta: paint(35), cyan: paint(36), grey: paint(90) };
const width = () => (process.stdout.columns || 120);
const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);
// One message per row: cut at the terminal width, counting only visible characters.
const out = (s) => {
  let line = "", seen = 0;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) { line += part; continue; }
    if (seen + part.length > width()) { line += part.slice(0, width() - seen - 1) + "…" + (tty ? "\x1b[0m" : ""); break; }
    line += part; seen += part.length;
  }
  console.log(line);
};

let server = "server";               // short name of the tapped server, from the "tap started" line
const pending = new Map();           // "c:0" -> { method, ms } for requests awaiting a response
const stats = { requests: 0, responses: 0, notifications: 0, calls: 0, errors: 0, latency: 0 };
const ms = (t) => { const [h, m, s] = t.split(":"); return (+h * 3600 + +m * 60 + +s) * 1000; };
const json = (v) => JSON.stringify(v ?? {});

// What is worth showing for each method, on the way out and on the way back.
function describeRequest(msg) {
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize": return `proposes ${c.bold(p.protocolVersion)} · client ${p.clientInfo?.name ?? "?"}`;
    case "tools/call": return `${c.bold(p.name)} ${c.yellow(json(p.arguments))}`;
    case "prompts/get": return c.bold(p.name);
    case "resources/read": return c.bold(p.uri);
    default: return "";
  }
}
function names(list = [], word) {
  const head = c.bold(`${list.length} ${word}${list.length === 1 ? "" : "s"}`);
  return list.length ? `${head}: ${list.map((x) => x.name).join(", ")}` : head;
}
function describeResult(method, r = {}) {
  switch (method) {
    case "initialize": return `speaks ${c.bold(r.protocolVersion)} · ${r.serverInfo?.name ?? "?"} · offers ${Object.keys(r.capabilities ?? {}).join(", ")}`;
    case "tools/list": return names(r.tools, "tool");
    case "prompts/list": return names(r.prompts, "prompt");
    case "resources/list": return names(r.resources, "resource");
    case "resources/read": return `${(r.contents ?? []).length} content part(s)`;
    case "roots/list": return `client reveals ${c.bold((r.roots ?? []).map((x) => x.uri).join(", "))}`;
    case "tools/call": {
      const text = (r.content ?? []).map((p) => p.text ?? `[${p.type}]`).join(" ").replace(/\s+/g, " ");
      return r.isError ? c.red("isError " + text) : text;
    }
    default: return "";
  }
}

function row(time, dir, mark, id, label, detail) {
  const toServer = dir === "client → server";
  const arrow = toServer ? c.cyan(" ──▶ ") : c.green(" ◀── ");
  const who = `${c.grey("opencode")}${arrow}${c.grey(clip(server, 12))}`;
  const tag = id === undefined ? "    " : c.dim(`#${id}`.padEnd(4));
  out(`${c.dim(time)}  ${who} ${tag} ${mark} ${label}${detail ? "  " + detail : ""}`);
}

function handle(line) {
  const started = line.match(/---- tap started: (.*) \(pid (\d+)\) ----/);
  if (started) {
    const last = started[1].split(" ").at(-1);
    server = last.split("/").at(-1).replace(/@[\w.-]+$/, "").replace(/^(mcp-)?server-|^mcp-server-/, "") || last;
    out("\n" + c.bold(`▶ tap started  ${started[1]}`) + c.dim(`  (pid ${started[2]})`));
    return;
  }
  const exited = line.match(/---- server exited with code (\S+) ----/);
  if (exited) { out(c.dim(`■ server process exited (code ${exited[1]}) · the session ended`)); return; }
  const m = line.match(/^(\d\d:\d\d:\d\d\.\d{3}) (client → server|server → client) (.*)$/);
  if (!m) return;
  const [, time, dir, rest] = m;
  let msg;
  for (let i = rest.indexOf("{"); i >= 0 && !msg; i = rest.indexOf("{", i + 1)) { try { msg = JSON.parse(rest.slice(i)); } catch {} }
  if (!msg) { row(time, dir, c.red("✗"), undefined, c.red("not JSON on the protocol channel"), c.yellow(clip(rest.replace(/^\(not JSON\)\s+/, "").trim(), 60))); return; }

  const side = dir === "client → server" ? "c" : "s";
  if (msg.method !== undefined && msg.id !== undefined) {          // a request
    stats.requests++;
    if (msg.method === "tools/call") stats.calls++;
    pending.set(`${side}:${msg.id}`, { method: msg.method, ms: ms(time) });
    const reversed = side === "s";
    const label = reversed ? c.magenta(c.bold(msg.method) + "  ← the server is asking") : c.bold(msg.method);
    row(time, dir, reversed ? c.magenta("?") : c.cyan("→"), msg.id, label, describeRequest(msg));
  } else if (msg.method !== undefined) {                          // a notification (no id, no reply)
    stats.notifications++;
    const loud = /list_changed/.test(msg.method);
    const extra = msg.params?.requestId !== undefined ? `for #${msg.params.requestId}` : "";
    row(time, dir, loud ? c.yellow("!") : c.dim("·"), undefined, loud ? c.yellow(msg.method) : c.dim(msg.method), c.dim(extra));
  } else {                                                         // a response to the other side's request
    stats.responses++;
    const req = pending.get(`${side === "c" ? "s" : "c"}:${msg.id}`) ?? { method: "?", ms: ms(time) };
    const took = ms(time) - req.ms;
    stats.latency += took;
    const timing = c.dim(`${String(took).padStart(5)} ms`);
    if (msg.error) { stats.errors++; row(time, dir, c.red("✗"), msg.id, c.red(`error ${msg.error.code}`), `${timing}  ${c.red(msg.error.message)}`); }
    else row(time, dir, c.green("✓"), msg.id, c.dim(req.method.padEnd(14)), `${timing}  ${describeResult(req.method, msg.result)}`);
  }
  dirty = true;
}

// A dim rule after each burst of traffic: a running tally of the conversation so far.
let dirty = false;
function tally() {
  if (!dirty) return;
  dirty = false;
  const avg = stats.responses ? Math.round(stats.latency / stats.responses) : 0;
  const n = (k, word) => `${stats[k]} ${word}${stats[k] === 1 ? "" : "s"}`;
  const text = ` ${n("requests", "request")} · ${n("responses", "response")} · ${n("notifications", "notification")} · ${n("calls", "tool call")} · avg ${avg} ms `;
  out(c.grey("──" + text + "─".repeat(Math.max(2, Math.min(width(), 100) - text.length - 2))));
}

// Follow the file like tail -f: read whatever was appended since last time.
let offset = 0, carry = "", idle;
function pump() {
  if (!existsSync(file)) return;
  const size = statSync(file).size;
  if (size < offset) { offset = 0; carry = ""; }                  // the log was truncated or replaced
  if (size === offset) return;
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  offset = size;
  const lines = (carry + buf.toString("utf8")).split("\n");
  carry = lines.pop();
  for (const line of lines) handle(line);
  clearTimeout(idle);
  idle = setTimeout(tally, 1200);
}

out(c.bold(`wiretap-view`) + c.dim(` · ${file} · ${once ? "replay" : "following, ctrl+c to stop"}`));
if (!existsSync(file) && !once) out(c.dim(`waiting for ${file} to appear: start opencode with the tap enabled…`));
pump();
if (once) { tally(); process.exit(0); }
setInterval(pump, 150);
process.on("SIGINT", () => { tally(); process.exit(0); });
