// probe: a stdio MCP server that interrogates the host that spawned it.
//
// One tool, probe_host. When the model calls it, the server tries every feature a server can ask
// of a client and reports what actually happened: the capabilities the client declared during
// initialize, whether tools/call carried a progressToken, whether the client accepts log messages,
// and whether it answers roots/list, elicitation and sampling requests.
//
// Point any MCP host at it (OpenCode, the Inspector's web UI, another editor) and compare.
//   npx tsx probe.ts    (normally started by the host, not by you)
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { writeFileSync } from "node:fs";
import * as z from "zod/v4";

const REPORT = new URL("./host-report.txt", import.meta.url).pathname;

serveStdio(() => {
  const server = new McpServer(
    { name: "probe", version: "1.0.0" },
    { capabilities: { logging: {} } },
  );

  server.registerTool("probe_host", {
    title: "Probe the MCP host",
    description: "Test which optional MCP features the connected host supports and report the results. Use it when the user asks to probe or test the host.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (_args, ctx) => {
    const rows: [string, string, string][] = [];
    const add = (feature: string, ok: boolean | null, detail: string) => rows.push([feature, ok === null ? "n/a" : ok ? "YES" : "no", detail]);

    const info = server.server.getClientVersion();
    const caps = server.server.getClientCapabilities() ?? {};
    add("client identity", true, `${info?.name ?? "?"} ${info?.version ?? ""}`.trim());
    add("declared capabilities", true, JSON.stringify(caps));

    const token = ctx.mcpReq._meta?.progressToken;
    add("progressToken on tools/call", token !== undefined, token === undefined ? "the host did not ask for progress" : `token ${JSON.stringify(token)}`);
    if (token !== undefined) {
      for (let i = 1; i <= 3; i++) {
        await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: i, total: 3, message: `probe step ${i}` } });
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    try { await ctx.mcpReq.log("info", "probe: hello from the server's log channel"); add("logging (notifications/message)", true, "sent; whether it is displayed is up to the host"); }
    catch (e) { add("logging (notifications/message)", false, (e as Error).message); }

    try { const r = await server.server.listRoots(); add("roots/list", true, r.roots.map((x) => x.uri).join(", ") || "(no roots)"); }
    catch (e) { add("roots/list", false, (e as Error).message); }

    try {
      const r = await ctx.mcpReq.elicitInput({ mode: "form", message: "Probe: pick a colour (or decline).", requestedSchema: { type: "object", properties: { colour: { type: "string", enum: ["red", "green", "blue"] } }, required: ["colour"] } }, { timeout: 120_000 });
      add("elicitation (ask the user)", true, `user answered: ${JSON.stringify(r)}`);
    } catch (e) { add("elicitation (ask the user)", false, (e as Error).message); }

    try {
      const r = await ctx.mcpReq.requestSampling({ messages: [{ role: "user", content: { type: "text", text: "Reply with the single word PONG." } }], maxTokens: 10 }, { timeout: 60_000 });
      add("sampling (borrow the host's model)", true, `model said: ${JSON.stringify(r.content)}`);
    } catch (e) { add("sampling (borrow the host's model)", false, (e as Error).message); }

    const width = Math.max(...rows.map((r) => r[0].length));
    const table = rows.map(([f, ok, d]) => `${f.padEnd(width)}  ${ok.padEnd(4)}  ${d}`).join("\n");
    writeFileSync(REPORT, `host report · ${new Date().toISOString()}\n\n${table}\n`);
    console.error(`[probe] report written to ${REPORT}`);
    return { content: [{ type: "text", text: `Probe finished. Results:\n${table}` }] };
  });

  return server;
});
