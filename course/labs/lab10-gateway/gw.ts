// gw.ts: talk to the gateway as one person, from the terminal. You play the model again.
//
//   npx tsx gw.ts --token bob-releaser-token tools
//   npx tsx gw.ts --token bob-releaser-token call teamdb_run_sql '{"sql":"SELECT name FROM customers LIMIT 3"}'
//   GW_TOKEN=carol-lead-token npx tsx gw.ts call gateway_status
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const args = process.argv.slice(2);
const i = args.indexOf("--token");
const TOKEN = i >= 0 ? args.splice(i, 2)[1] : process.env.GW_TOKEN ?? "alice-dev-token";
const [cmd = "tools", name, json] = args;
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c: string) => (s: unknown) => (color ? `\x1b[${c}m${s}\x1b[0m` : String(s));
const [bold, dim, red, green] = ["1", "2", "31", "32"].map(paint);

const client = new Client({ name: "gw.ts", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.GW_URL ?? "http://127.0.0.1:8800/mcp"), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
try {
  if (cmd === "tools") {
    const { tools } = await client.listTools();
    console.log(dim(`${tools.length} tools offered to ${TOKEN.split("-")[0]}:`));
    for (const t of tools) console.log(`  ${bold(t.name)}  ${dim((t.description ?? "").replace(/\s+/g, " ").slice(0, 90))}`);
  } else if (cmd === "call" && name) {
    const r = await client.callTool({ name, arguments: json ? JSON.parse(json) : {} }, { timeout: 120_000 });
    const text = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join("\n");
    console.log(`${r.isError ? red("tool error") : green("result")}: ${text}`);
  } else console.log("usage: gw.ts [--token T] tools | call <tool> [json]");
} catch (e) { console.log(red(`${(e as Error).name}: ${(e as Error).message}`)); process.exitCode = 1; }
await client.close();
