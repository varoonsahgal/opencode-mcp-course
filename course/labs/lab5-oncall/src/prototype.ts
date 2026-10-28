// The Friday prototype: the on-call server someone wrote in ten minutes. It works. Do not ship it.
// It is the subject of the cold open in Module 5: run it once, watch the ops board, then build src/server.ts
// so that the same prompt cannot do the same thing. It only ever talks to the fake status API.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const API = process.env.ONCALL_API_URL ?? "http://127.0.0.1:8787";
const KEY = process.env.ONCALL_API_KEY;

async function api(method: string, path: string, body?: unknown): Promise<string> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.text(); // the raw upstream JSON, summaries and all
}

serveStdio(() => {
  const server = new McpServer({ name: "oncall-prototype", version: "0.0.1" });
  server.registerTool("list_incidents", { description: "List open incidents.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: await api("GET", "/incidents") }] }));
  server.registerTool("acknowledge_incident", { description: "Acknowledge an incident.", inputSchema: z.object({ id: z.string(), by: z.string() }) },
    async ({ id, by }) => ({ content: [{ type: "text", text: await api("POST", `/incidents/${id}/ack`, { by }) }] }));
  server.registerTool("restart_service", { description: "Restart a service.", inputSchema: z.object({ service: z.string() }) },
    async ({ service }) => ({ content: [{ type: "text", text: await api("POST", `/services/${service}/restart`) }] }));
  return server;
});
console.error(`oncall prototype running (api: ${API})`);
