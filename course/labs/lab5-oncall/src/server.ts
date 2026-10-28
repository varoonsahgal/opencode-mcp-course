// Applied challenge skeleton: an "on-call helper" MCP server in front of the status API.
// Decide what to expose, build it, wire it into OpenCode, lock it down.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const API = process.env.ONCALL_API_URL ?? "http://127.0.0.1:8787";
const KEY = process.env.ONCALL_API_KEY;
if (!KEY) {
  console.error("ONCALL_API_KEY is not set. Refusing to start without credentials.");
  process.exit(1);
}

/** Authenticated call to the status API. The token never leaves this function. */
async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

serveStdio(() => {
  const server = new McpServer({ name: "oncall", version: "0.1.0" });

  // Your design goes here. Suggested shape (see the challenge brief):
  //   tools:     get_service_status (read), list_open_incidents (read), acknowledge_incident (write, needs approval)
  //   resource:  runbook://{service}  -> the matching file under runbooks/
  //   prompt:    triage  -> the standard "what is broken and what do I do first" workflow
  //   NOT exposed: restart, raw HTTP, the API key

  return server;
});
console.error(`oncall MCP server running (api: ${API})`);
