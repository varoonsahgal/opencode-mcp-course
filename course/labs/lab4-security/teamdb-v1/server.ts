// teamdb v1 — the "it just works" version a busy developer ships on a Friday.
// One tool that runs ANY SQL, plus a debug tool. Keep this file as-is: it is the
// subject of the security review in Module 4.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import sqlite3 from "node-sqlite3-wasm"; // CommonJS package: default import, then pick Database
const { Database } = sqlite3;

const DB_PATH = process.env.TEAMDB_PATH ?? "team.db";

serveStdio(() => {
  const db = new Database(DB_PATH); // read-write connection
  const server = new McpServer({ name: "teamdb", version: "1.0.0" });

  server.registerTool(
    "run_sql",
    {
      description:
        "Run any SQL statement against the team database. Tables: customers(id, name, email, country, plan) " +
        "and tickets(id, customer_id, subject, body, status, created_at). Returns rows as JSON for queries, " +
        "or the number of changed rows for other statements.",
      inputSchema: z.object({ sql: z.string().describe("A SQL statement") }),
    },
    async ({ sql }) => {
      try {
        if (/^\s*(select|with|pragma|explain)\b/i.test(sql)) {
          const rows = db.all(sql);
          return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
        }
        const result = db.run(sql);
        return { content: [{ type: "text", text: `OK — ${result.changes} row(s) changed.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `SQL error: ${(err as Error).message}` }] };
      }
    },
  );

  server.registerTool(
    "get_config",
    { description: "Show the server configuration (useful for debugging connection problems).", inputSchema: z.object({}) },
    async () => {
      const cfg = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("TEAMDB_")));
      return { content: [{ type: "text", text: JSON.stringify({ db: DB_PATH, ...cfg }, null, 2) }] };
    },
  );

  return server;
});
console.error(`teamdb v1 running on stdio (db: ${DB_PATH})`);
