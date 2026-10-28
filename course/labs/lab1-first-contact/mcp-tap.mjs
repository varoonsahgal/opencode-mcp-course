#!/usr/bin/env node
// mcp-tap: a transparent wiretap for stdio MCP servers.
//
// It sits between the MCP client (OpenCode) and the real server, forwards every
// byte in both directions untouched, and writes a human-readable copy of each
// JSON-RPC message to a log file. Nothing about the protocol changes; you are
// simply watching the conversation.
//
//   usage: node mcp-tap.mjs <logfile> -- <command> [args...]
//   e.g.   node mcp-tap.mjs mcp-traffic.log -- uvx mcp-server-time
//
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const sep = process.argv.indexOf("--");
const logFile = process.argv[2];
const cmd = sep > 0 ? process.argv.slice(sep + 1) : [];
if (!logFile || cmd.length === 0) {
  console.error("usage: node mcp-tap.mjs <logfile> -- <command> [args...]");
  process.exit(2);
}

const stamp = () => new Date().toISOString().slice(11, 23);
appendFileSync(logFile, `\n${stamp()} ---- tap started: ${cmd.join(" ")} (pid ${process.pid}) ----\n`);

function summarize(msg) {
  if (msg.method !== undefined && msg.id !== undefined) return `REQUEST   #${msg.id} ${msg.method}`;
  if (msg.method !== undefined) return `NOTIFY    ${msg.method}`;
  if (msg.error !== undefined) return `ERROR     #${msg.id} code=${msg.error.code} ${msg.error.message}`;
  return `RESPONSE  #${msg.id}`;
}

function logLine(direction, line) {
  let summary = "(not JSON)";
  try { summary = summarize(JSON.parse(line)); } catch {}
  appendFileSync(logFile, `${stamp()} ${direction} ${summary.padEnd(44)} ${line}\n`);
}

// Forward a stream byte-for-byte while splitting a copy into lines for the log.
function tap(from, to, direction) {
  let buffer = "";
  from.on("data", (chunk) => {
    to.write(chunk);
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) logLine(direction, line);
    }
  });
}

const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
tap(process.stdin, child.stdin, "client → server");
tap(child.stdout, process.stdout, "server → client");
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code) => {
  appendFileSync(logFile, `${stamp()} ---- server exited with code ${code} ----\n`);
  process.exit(code ?? 0);
});
