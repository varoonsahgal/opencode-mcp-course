// A 25-line MCP server, used only as a fallback if `uvx` is not installed.
// It exposes the same tool name as the official reference `time` server.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

serveStdio(() => {
  const server = new McpServer({ name: "time", version: "1.0.0" });

  server.registerTool(
    "get_current_time",
    {
      description: "Get the current date and time in an IANA timezone such as 'Asia/Tokyo' or 'Europe/Berlin'.",
      inputSchema: z.object({ timezone: z.string().describe("IANA timezone name, e.g. 'America/New_York'") }),
    },
    async ({ timezone }) => {
      try {
        const now = new Date();
        const formatted = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "full", timeStyle: "long" }).format(now);
        return { content: [{ type: "text", text: JSON.stringify({ timezone, datetime: formatted, iso: now.toISOString() }) }] };
      } catch {
        return { isError: true, content: [{ type: "text", text: `Unknown timezone '${timezone}'. Use an IANA name like 'Europe/Paris'.` }] };
      }
    },
  );

  return server;
});
console.error("time-server (fallback) running on stdio");
