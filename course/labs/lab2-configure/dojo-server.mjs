// Debugging dojo: one server, three ways to fail. The config decides which.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

// Failure 2: a required credential is missing -> the process exits before speaking MCP.
if (!process.env.DOJO_API_KEY) {
  console.error("dojo: DOJO_API_KEY is not set, refusing to start");
  process.exit(1);
}
// Failure 3: a slow start (think: npx downloading, a Python venv being built) -> client timeout.
const slowMs = Number(process.env.DOJO_SLOW_MS ?? 0);
if (slowMs > 0) {
  console.error(`dojo: pretending to warm up for ${slowMs} ms`);
  await new Promise((r) => setTimeout(r, slowMs));
}

serveStdio(() => {
  const server = new McpServer({ name: "dojo", version: "1.0.0" });
  server.registerTool(
    "roll_dice",
    { description: "Roll an N-sided die.", inputSchema: z.object({ sides: z.number().int().min(2).max(1000).default(6) }) },
    async ({ sides }) => ({ content: [{ type: "text", text: String(1 + Math.floor(Math.random() * sides)) }] }),
  );
  return server;
});
console.error("dojo: ready");
