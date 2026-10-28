#!/usr/bin/env node
// Pre-flight check for the "MCP with AI Agents" course. Run:  npm run check   (from course/labs)
// Each check prints as soon as it finishes, with a spinner while it runs. NO_COLOR=1 for plain output.
import { exec } from "node:child_process";
import { existsSync } from "node:fs";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [green, yellow, red, dim, bold, indigo] = [paint("32"), paint("33"), paint("31"), paint("2"), paint("1"), paint("38;5;105")];
const sh = (cmd) => new Promise((resolve, reject) =>
  exec(cmd, { timeout: 120000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.toString().trim()))));

const results = [];
const ICON = { ok: green("✔"), warn: yellow("▲"), fail: red("✖") };

// Run one check with a live spinner; the check returns [status, detail].
async function check(name, fn) {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const started = Date.now();
  let i = 0;
  const timer = tty ? setInterval(() => process.stdout.write(`\r  ${indigo(frames[i++ % frames.length])}  ${name.padEnd(28)} ${dim("    ·  checking…")}`), 80) : null;
  let status, detail;
  try { [status, detail] = await fn(); } catch (e) { [status, detail] = ["fail", e.message]; }
  if (timer) clearInterval(timer);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const color = status === "ok" ? (s) => s : status === "warn" ? yellow : red;
  process.stdout.write(`${tty ? "\r\x1b[K" : ""}  ${ICON[status]}  ${name.padEnd(28)} ${dim(`${secs}s`.padStart(5))}  ${color(detail)}\n`);
  results.push(status);
}

console.log(`\n  ${bold("MCP with AI Agents")} ${dim("· pre-flight")}\n`);

await check("Node.js", async () => {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 20 ? ["ok", `v${process.versions.node}`] : ["fail", `v${process.versions.node} — need 20 or newer`];
});

await check("Lab dependencies", async () =>
  existsSync(new URL("./node_modules/@modelcontextprotocol/server", import.meta.url))
    ? ["ok", "node_modules present (MCP SDK, tsx, zod, sqlite)"]
    : ["fail", "run `npm install` in course/labs"]);

await check("OpenCode", async () => {
  try { return ["ok", `v${await sh("opencode --version")}`]; } catch { return ["fail", "not on PATH — install from https://opencode.ai"]; }
});

await check("OpenCode Zen login", async () => {
  try {
    return /opencode/i.test(await sh("opencode auth list"))
      ? ["ok", "provider 'opencode' is authenticated"]
      : ["warn", "run `opencode auth login` and choose OpenCode (Zen)"];
  } catch { return ["warn", "could not run `opencode auth list`"]; }
});

await check("uv / uvx (optional)", async () => {
  try { return ["ok", (await sh("uvx --version")).split(" ").slice(0, 2).join(" ")]; } catch { return ["warn", "not found — Lab 1 falls back to time-server.mjs (set time-js enabled:true)"]; }
});

for (const [name, url] of [["Open-Meteo API (Lab 3)", "https://geocoding-api.open-meteo.com/v1/search?name=Paris&count=1"], ["DeepWiki MCP (Lab 2)", "https://mcp.deepwiki.com/mcp"], ["npm registry", "https://registry.npmjs.org/-/ping"]]) {
  await check(name, async () => {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return ["ok", `reachable (HTTP ${r.status})`]; }
    catch (e) { return ["warn", `unreachable (${e.message})`]; }
  });
}

// Warm the npx caches so the first OpenCode start in class is fast.
await check("npx caches warmed", async () => {
  try { await sh("npx -y @modelcontextprotocol/inspector --cli npx -y @modelcontextprotocol/server-everything@2.0.0 --method tools/list"); return ["ok", "inspector + everything server downloaded"]; }
  catch { return ["warn", "could not pre-download (check network); first start may be slow"]; }
});

const bad = results.filter((s) => s === "fail").length;
const warned = results.filter((s) => s === "warn").length;
console.log(bad
  ? `\n  ${red(bold(`${bad} blocking problem(s).`))} Fix them before class.\n`
  : `\n  ${green(bold("All set."))} ${warned ? dim(`(${warned} optional warning${warned > 1 ? "s" : ""}) `) : ""}See you in Module 1.\n`);
process.exit(bad ? 1 : 0);
