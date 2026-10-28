#!/usr/bin/env node
// context-tax: measure what your MCP setup costs the model on EVERY turn.
//
// It reads opencode.json, connects to each enabled server the way OpenCode does
// (local: spawn + JSON-RPC over stdio; remote: Streamable HTTP POSTs), asks for
// tools/list, and charts how many tokens each server adds to the context: its tool
// definitions plus the `instructions` it returns from initialize (OpenCode puts those
// in the system prompt too). Failing servers show the same symptom `opencode mcp list` does.
//
//   usage: node context-tax.mjs [--all] [--stderr] [--watch] [config]
//     --all     include servers with "enabled": false
//     --stderr  show the last lines each failing local server printed to stderr
//     --watch   re-measure every time the config file is saved
//
import { spawn } from "node:child_process";
import { readFileSync, watch } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const CONFIG = path.resolve(args.find((a) => !a.startsWith("--")) ?? "opencode.json");
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [dim, bold, red, green, yellow, cyan] = [2, 1, 31, 32, 33, 36].map(paint);
const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "context-tax", version: "1.0.0" } };

// {env:NAME} -> value of NAME (empty if unset), as OpenCode does. {file:...} is left alone here.
const subst = (v) => String(v).replace(/\{env:([^}]+)\}/g, (_, n) => process.env[n] ?? "");
const tokens = (tools) => Math.round(JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length / 4);

// The lines of stderr worth reading: error messages, not stack frames.
function lastWords(stderr) {
  const lines = stderr.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const key = lines.filter((l) => /error|cannot|refus|not set|missing|warm/i.test(l));
  return (key.length ? key : lines).slice(-3).join("\n");
}

function measureLocal(name, cfg) {
  // OpenCode 1.18 silently drops a local entry whose command is not an array: it never shows up at all.
  if (!Array.isArray(cfg.command)) return Promise.resolve({ error: "OpenCode would not list this entry at all; compare with opencode debug config" });
  const timeout = cfg.timeout ?? 30000;
  const env = { ...process.env, ...Object.fromEntries(Object.entries(cfg.environment ?? {}).map(([k, v]) => [k, subst(v)])) };
  return new Promise((resolve) => {
    let child, out = "", stderr = "", done = false, nextId = 0;
    const pending = new Map(), tools = [];
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); child?.kill(); resolve({ ...r, stderr: lastWords(stderr) }); };
    const timer = setTimeout(() => finish({ error: `Operation timed out after ${timeout}ms` }), timeout);
    const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    const request = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); send({ id, method, params }); });
    try {
      child = spawn(cfg.command[0], cfg.command.slice(1), { cwd: path.resolve(path.dirname(CONFIG), cfg.cwd ?? "."), env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) { return finish({ error: e.message }); }
    child.on("error", (e) => finish({ error: e.code === "ENOENT" ? `Executable not found in $PATH: "${cfg.command[0]}"` : e.message }));
    child.on("exit", (code) => finish({ error: `MCP error -32000: Connection closed (exit code ${code})` }));
    child.stdin.on("error", () => {});
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.on("data", (c) => {
      out += c;
      let nl;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim(); out = out.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; } // non-JSON stdout: skipped, like OpenCode
        if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    });
    (async () => {
      const init = await request("initialize", INIT);
      if (init.error) return finish({ error: `initialize failed: ${init.error.message}` });
      send({ method: "notifications/initialized" });
      let cursor;
      do {
        const page = await request("tools/list", cursor ? { cursor } : {});
        if (page.error) return finish({ error: `tools/list failed: ${page.error.message}` });
        tools.push(...page.result.tools); cursor = page.result.nextCursor;
      } while (cursor);
      finish({ tools, instructions: init.result.instructions ?? "" });
    })();
  });
}

async function measureRemote(name, cfg) {
  const timeout = cfg.timeout ?? 30000;
  let session, nextId = 0;
  const headers = () => ({ "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(session && { "mcp-session-id": session }), ...Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, subst(v)])) });
  const post = async (msg) => {
    const id = msg.method.startsWith("notifications/") ? undefined : nextId++;
    const res = await fetch(cfg.url, { method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", id, ...msg }), signal: AbortSignal.timeout(timeout) });
    session = res.headers.get("mcp-session-id") ?? session;
    if (res.status === 401) throw new Error("needs_auth (HTTP 401)");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (id === undefined) return;
    const body = await res.text(); // plain JSON, or an SSE stream of "data:" lines
    const msgs = (res.headers.get("content-type") ?? "").includes("event-stream")
      ? body.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(body)];
    const reply = msgs.find((m) => m.id === id);
    if (!reply || reply.error) throw new Error(`${msg.method} failed: ${reply?.error?.message ?? "no response"}`);
    return reply.result;
  };
  try {
    const init = await post({ method: "initialize", params: INIT });
    await post({ method: "notifications/initialized" });
    const tools = [];
    let cursor;
    do { const page = await post({ method: "tools/list", params: cursor ? { cursor } : {} }); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
    return { tools, instructions: init.instructions ?? "" };
  } catch (e) {
    return { error: e.name === "TimeoutError" ? `Operation timed out after ${timeout}ms` : e.message };
  }
}

function bar(value, max, width = 30) {
  const cells = max ? (value / max) * width : 0, full = Math.floor(cells);
  return "█".repeat(full) + (["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"][Math.round((cells - full) * 7)] ?? "");
}

// One bar, two colours: tool schemas (cyan) then server instructions (yellow).
function stacked(part, total, max) {
  const whole = bar(total, max), split = Math.min(Math.round(max ? (part / max) * 30 : 0), whole.length);
  return cyan(whole.slice(0, split)) + yellow(whole.slice(split));
}

async function report() {
  let config;
  try { config = JSON.parse(readFileSync(CONFIG, "utf8").replace(/^\s*\/\/.*$/gm, "")); }
  catch (e) { return console.log(red(`cannot read ${CONFIG}: ${e.message}`)); }
  const entries = Object.entries(config.mcp ?? {}).filter(([, c]) => flag("--all") || c.enabled !== false);
  const started = Date.now();
  const results = await Promise.all(entries.map(async ([name, cfg]) => ({ name, cfg, ...(await (cfg.type === "remote" ? measureRemote(name, cfg) : measureLocal(name, cfg))) })));
  const ok = results.filter((r) => r.tools);
  for (const r of ok) { r.toolTokens = tokens(r.tools); r.instrTokens = Math.round(r.instructions.length / 4); r.tokens = r.toolTokens + r.instrTokens; }
  const max = Math.max(0, ...ok.map((r) => r.tokens));
  const total = ok.reduce((n, r) => n + r.tokens, 0), toolCount = ok.reduce((n, r) => n + r.tools.length, 0);

  if (flag("--watch") && color) process.stdout.write("\x1b[H\x1b[2J");
  console.log(`\n ${bold("context tax")} ${dim("·")} ${path.relative(process.cwd(), CONFIG) || CONFIG} ${dim(`· measured in ${((Date.now() - started) / 1000).toFixed(1)}s`)}\n`);
  console.log(dim(`   ${"server".padEnd(14)} ${"type".padEnd(7)} ${"tools".padStart(5)} ${"schemas".padStart(8)} ${"instr.".padStart(7)} ${"~tokens".padStart(8)}`));
  for (const r of results.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1))) {
    const head = ` ${r.tools ? green("●") : red("●")} ${r.name.padEnd(14)} ${dim((r.cfg.type ?? "local").padEnd(7))}`;
    const n = (v) => v.toLocaleString("en");
    if (r.tools) console.log(`${head} ${String(r.tools.length).padStart(5)} ${dim(n(r.toolTokens).padStart(8))} ${dim(n(r.instrTokens).padStart(7))} ${bold(n(r.tokens).padStart(8))}  ${stacked(r.toolTokens, r.tokens, max)}`);
    else {
      console.log(`${head} ${red("    –")}  ${red(r.error)}`);
      if (flag("--stderr") && r.stderr) console.log(r.stderr.split("\n").map((l) => dim("     │ ") + yellow(l)).join("\n"));
    }
  }
  const heavy = ok.flatMap((r) => r.tools.map((t) => ({ name: `${r.name}_${t.name}`, tokens: tokens([t]) }))).sort((a, b) => b.tokens - a.tokens).slice(0, 3);
  if (heavy.length) console.log(dim("\n heaviest tools"));
  for (const t of heavy) console.log(`   ${t.name.padEnd(40)} ${String(t.tokens).padStart(5)}  ${cyan(bar(t.tokens, max))}`);
  console.log(`\n ${bold("per-turn MCP tax:")} ${green(`~${total.toLocaleString("en")} tokens`)} for ${toolCount} tools, sent with every message before you type a word.`);
  console.log(dim(` ≈ JSON chars ÷ 4 · `) + cyan("█") + dim(" tool schemas ") + yellow("█") + dim(" server instructions · OpenCode's own prompt comes on top"));
  const failed = results.length - ok.length;
  if (failed) console.log(red(`\n ${failed} server(s) failed.`) + dim(flag("--stderr") ? "" : " Form a hypothesis, then run the command yourself (or add --stderr)."));
  if (flag("--watch")) console.log(dim(`\n watching ${path.basename(CONFIG)} · save it to re-measure · ctrl+c to quit`));
}

await report();
if (flag("--watch")) {
  let busy = false, again = false, debounce;
  const rerun = async () => { if (busy) return void (again = true); busy = true; process.stdout.write(yellow("\n measuring…")); await report(); busy = false; if (again) { again = false; rerun(); } };
  // Editors often replace the file on save, so watch the directory and filter by name.
  watch(path.dirname(CONFIG), (_, file) => { if (file === path.basename(CONFIG)) { clearTimeout(debounce); debounce = setTimeout(rerun, 250); } });
  process.on("SIGINT", () => { console.log(); process.exit(0); });
} else process.exit(0);
