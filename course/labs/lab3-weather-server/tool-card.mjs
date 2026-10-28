#!/usr/bin/env node
// tool-card: see your server exactly as the model sees it, and score each tool against
// the design rules from Module 3.2.
//
// It starts your server, speaks raw JSON-RPC over stdio (initialize, tools/list, ...),
// draws one card per tool, and gives it a score out of 10. With --watch it re-runs every
// time you save a file under src/, so you can keep it open in a second terminal.
//
//   usage: node tool-card.mjs [--watch] [-- <command> [args...]]
//   e.g.   node tool-card.mjs --watch                 (defaults to: npx tsx src/server.ts)
//
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
const cmd = sep >= 0 ? args.slice(sep + 1) : ["npx", "tsx", "src/server.ts"];
const watching = args.includes("--watch");

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [bold, dim, red, green, yellow, cyan, amber] = ["1", "90", "31", "32", "33", "36", "38;5;214"].map(paint);
const width = Math.min(process.stdout.columns || 100, 100);

/** Start the server, run the handshake, return what a client would discover. */
function discover() {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map();
    let buffer = "", stderr = "", nextId = 0;
    const fail = (why) => { child.kill(); resolve({ error: why, stderr }); };
    const timer = setTimeout(() => fail("no answer within 20 s"), 20000);
    const send = (method, params = {}) => new Promise((res) => {
      const id = nextId++;
      pending.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => fail(e.message));
    child.on("exit", (code) => fail(`server exited with code ${code} before answering`));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // not JSON: a stdout logging bug, but keep going
        if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    });
    (async () => {
      const init = await send("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "tool-card", version: "1.0.0" } });
      if (init.error) return fail(init.error.message);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const caps = init.result.capabilities ?? {};
      const list = async (method, key) => (caps[key] ? (await send(method)).result?.[key] ?? [] : []);
      const out = { server: init.result.serverInfo, version: init.result.protocolVersion,
        tools: await list("tools/list", "tools"), resources: await list("resources/list", "resources"), prompts: await list("prompts/list", "prompts") };
      clearTimeout(timer);
      child.removeAllListeners("exit");
      child.kill();
      resolve(out);
    })();
  });
}

/** The 3.2 design rules, as ten checks. Each returns [passed, label, hint]. */
function score(tool) {
  const d = tool.description ?? "";
  const props = Object.entries(tool.inputSchema?.properties ?? {});
  const constrained = (p) => p.enum || p.const || p.pattern || p.format ||
    (p.type === "string" && (p.minLength !== undefined || p.maxLength !== undefined)) ||
    ((p.type === "number" || p.type === "integer") && (p.minimum !== undefined || p.maximum !== undefined)) ||
    p.type === "boolean";
  const a = tool.annotations ?? {};
  const hints = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  return [
    [/^[a-z]+(_[a-z0-9]+)+$/.test(tool.name) && tool.name.length < 64, "name is verb_object snake_case", "e.g. get_weather, list_open_tickets"],
    [!!tool.title, "has a human title", "a short human label, e.g. title: \"Current weather\""],
    [d.length >= 60, "description is substantive", "say what it returns, in one or two sentences"],
    [/\b(use (this|it)? ?(when|whenever|for|to)|call (this|it) when)\b/i.test(d), "says WHEN to use it", "e.g. \"Use this whenever the user asks ...\""],
    [/\b(not|never|cannot|can't|don't|do not|only)\b/i.test(d), "says when NOT to use it", "e.g. \"Not a forecast: cannot answer questions about tomorrow\""],
    [props.every(([, p]) => p.description), "every parameter is described", "add .describe(\"...\") to each zod field"],
    [props.every(([, p]) => constrained(p)), "every input is constrained", ".min() .max() z.enum() .regex(): fewer ways to be wrong"],
    [hints.every((h) => typeof a[h] === "boolean"), "all four annotations set", hints.join(", ")],
    [!!tool.outputSchema, "has an outputSchema", "typed structuredContent for programs"],
    [d.length <= 600, "description fits a budget", `${d.length} chars: it is pasted into every turn`],
  ];
}

// Only name, description and inputSchema are pasted into the model's context; title, annotations
// and outputSchema are for the host and for programs.
const tokens = (t) => Math.round(JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length / 4);
const rule = (ch = "─") => dim(ch.repeat(width));
const wrap = (text, indent) => {
  const out = [], max = width - indent.length;
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > max) { out.push(indent + line.trim()); line = ""; }
    line += " " + word;
  }
  if (line.trim()) out.push(indent + line.trim());
  return out.join("\n");
};

function card(tool) {
  const checks = score(tool);
  const points = checks.filter(([ok]) => ok).length;
  const colour = points === 10 ? green : points >= 7 ? amber : red;
  const bar = colour("■".repeat(points)) + dim("□".repeat(10 - points));
  const lines = [rule(), `${bold(cyan(tool.name))}  ${dim(tool.title ?? "(no title)")}${" ".repeat(4)}${bar} ${bold(colour(points + "/10"))}   ${dim("~" + tokens(tool) + " tokens/turn")}`, ""];
  lines.push(wrap(tool.description ?? red("(no description: the model has to guess from the name)"), "  "), "");
  for (const [name, p] of Object.entries(tool.inputSchema?.properties ?? {})) {
    const req = (tool.inputSchema.required ?? []).includes(name) ? "" : dim("?");
    const limits = ["minLength", "maxLength", "minimum", "maximum", "pattern", "enum"].filter((k) => p[k] !== undefined).map((k) => `${k}=${JSON.stringify(p[k])}`).join(" ");
    lines.push(`  ${yellow(name)}${req}: ${p.type ?? "any"} ${dim(limits)}`);
    if (p.description) lines.push(dim(wrap(p.description, "      ")));
  }
  if (tool.annotations) lines.push("", "  " + dim(Object.entries(tool.annotations).map(([k, v]) => `${k}=${v}`).join("  ") + "  (host only)"));
  lines.push("");
  for (const [ok, label, hint] of checks) lines.push(`  ${ok ? green("✓") : red("✗")} ${ok ? label : bold(label)}${ok ? "" : dim("  → " + hint)}`);
  return lines.join("\n");
}

async function run() {
  const found = await discover();
  if (tty && watching) process.stdout.write("\x1b[2J\x1b[H");
  const title = `${bold("tool-card")} ${dim("· what the model sees · " + cmd.join(" "))}`;
  if (found.error) {
    console.log(`${title}\n\n${red("✗ could not talk to the server: " + found.error)}\n`);
    if (found.stderr.trim()) console.log(dim("server stderr:\n") + red(found.stderr.trim().split("\n").slice(-15).join("\n")));
  } else {
    const { server, version, tools, resources, prompts } = found;
    console.log(`${title}\n${dim(`server ${server?.name} ${server?.version} · protocol ${version}`)}  ` +
      [[tools, "tool"], [resources, "resource"], [prompts, "prompt"]].map(([l, n]) => cyan(`${l.length} ${n}${l.length === 1 ? "" : "s"}`)).join(dim(" · ")));
    if (tools.length === 0) console.log(`\n${amber("0 tools.")} A valid server with nothing to offer: the model sees nothing here.\n${dim("Register a tool (TODO 1) and save; this card fills in.")}`);
    for (const t of tools) console.log(card(t));
    if (resources.length || prompts.length) {
      console.log(rule());
      for (const r of resources) console.log(`  ${cyan("@")} ${r.uri}  ${dim(r.name + (r.mimeType ? " · " + r.mimeType : ""))}`);
      for (const p of prompts) console.log(`  ${cyan("/")}${server?.name}:${p.name}:mcp  ${dim((p.arguments ?? []).map((a) => a.name).join(", "))}`);
    }
    const total = tools.reduce((n, t) => n + tokens(t), 0);
    console.log(rule() + "\n" + dim(`context tax of this server's tool list: ~${total} tokens on every turn`));
  }
  if (watching) console.log(dim(`\nwatching src/ … save a file to re-score · ctrl+c to quit`));
}

await run();
if (watching && existsSync("src")) {
  let timer;
  watch("src", { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  process.on("SIGINT", () => { console.log(); process.exit(0); });
}
