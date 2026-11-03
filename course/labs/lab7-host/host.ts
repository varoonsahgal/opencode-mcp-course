// host.ts: a complete MCP host in one file. Today, you are the model.
//
//   npx tsx host.ts [servers.json]
//
// It reads a config shaped like OpenCode's, connects one Client to every enabled server, builds a
// single namespaced tool catalogue, and gives you a prompt where YOU play the model: list tools,
// call them, read resources, run prompts. Everything a host owes its servers lives in the TODOs:
//
//   TODO 1  declare client capabilities, and answer roots/list
//   TODO 2  answer elicitation requests (form and URL) from the terminal
//   TODO 3  show progress while a tool runs, and cancel it when you press ctrl+c
//   TODO 4  react to tools/list_changed, and pin tool definitions so a change is noticed
//
// Commands: help · servers · caps · tools [server] · call <server_tool> [json] · resources ·
//           read <server> <uri> · prompts · prompt <server> <name> [json] · trust <server_tool> · quit
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client, StreamableHTTPClientTransport, type ClientCapabilities, type Tool, type CallToolResult, type ElicitRequestParams, type ElicitResult, type CreateMessageRequestParams, type CreateMessageResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// ---------------------------------------------------------------------------------------------
// Config: the same shape OpenCode uses, so you can read one and know the other.
// ---------------------------------------------------------------------------------------------
type ServerConfig =
  | { type: "local"; command: string[]; environment?: Record<string, string>; enabled?: boolean }
  | { type: "remote"; url: string; headers?: Record<string, string>; enabled?: boolean };
const CONFIG_FILE = process.argv[2] ?? "servers.json";
const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { servers: Record<string, ServerConfig> };
const subst = (s: string) => s.replace(/\{env:([A-Za-z0-9_]+)\}/g, (_, v: string) => process.env[v] ?? ""); // {env:VAR}, like OpenCode

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: unknown) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [bold, dim, red, green, yellow, cyan, magenta] = ["1", "2", "31", "32", "33", "36", "35"].map(paint);
const say = (s: string) => console.log(s);

// =============================================================================================
// TODO 1 · What this host can do for a server. Everything you declare here, you must also handle
// below; everything you leave out, servers must live without. OpenCode 1.19 declares { roots: {} }.
// =============================================================================================
const CAPABILITIES: ClientCapabilities = {
  // TODO 1: declare what you will handle, e.g.
  //   roots: { listChanged: false },          → and answer roots/list in connect()
  //   elicitation: { form: {}, url: {} },     → and answer elicitation/create (TODO 2)
  //   sampling: {},                           → and answer sampling/createMessage (the stub below)
};

// ---------------------------------------------------------------------------------------------
// The catalogue: every tool from every server, namespaced server_tool like OpenCode does.
// TODO 4 adds pinning: a SHA-256 of each definition, remembered in host.lock.json.
// ---------------------------------------------------------------------------------------------
type Entry = { server: string; client: Client; tool: Tool; hash: string; status: "pinned" | "new" | "changed" };
const catalog = new Map<string, Entry>();
const servers = new Map<string, { client: Client; cfg: ServerConfig }>();
const LOCK = "host.lock.json";
let pins: Record<string, string> = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : {};
const hashTool = (t: Tool) => createHash("sha256").update(JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })).digest("hex").slice(0, 16);

async function refreshTools(name: string, client: Client, why: string) {
  for (const [key, e] of catalog) if (e.server === name) catalog.delete(key);
  const { tools } = await client.listTools();
  const changed: string[] = [];
  for (const tool of tools) {
    const key = `${name}_${tool.name}`;
    const hash = hashTool(tool);
    // TODO 4 (pinning): first sight → pins[key] = hash, status "new". Same hash → "pinned". Different
    //        hash → "changed" (push key onto `changed`): call() then refuses it until `trust <tool>`.
    const status: Entry["status"] = "pinned";
    catalog.set(key, { server: name, client, tool, hash, status });
  }
  writeFileSync(LOCK, JSON.stringify(pins, null, 2) + "\n");
  say(dim(`  ${name}: ${tools.length} tool${tools.length === 1 ? "" : "s"} (${why})`));
  for (const key of changed) say(red(`  ⚠ ${key} changed since you pinned it. Review it with \`tools\`, then \`trust ${key}\` if you accept the new definition.`));
}

// ---------------------------------------------------------------------------------------------
// Talking to the human. One readline for the REPL and for every question a server asks.
// ---------------------------------------------------------------------------------------------
const rl = createInterface({ input, output, terminal: !!input.isTTY });
let inflight: AbortController | undefined; // the tool call in progress, if any (TODO 3)
rl.on("SIGINT", () => {
  if (inflight) { say(yellow("\n  ctrl+c: cancelling the call (notifications/cancelled)")); inflight.abort(); return; }
  void shutdown();
});

// TODO 2 · A server asked the user something. Render the form, collect typed answers, or offer the URL.
async function elicit(from: string, p: ElicitRequestParams): Promise<ElicitResult> {
  say(magenta(`\n  ${from} asks: ${p.message}`));
  // TODO 2: render the request and collect the answer.
  //   p.mode === "url"  → show p.url, let the user open it, return { action: "accept" } (or decline/cancel).
  //   otherwise          → for each field in p.requestedSchema.properties ask with rl.question(); respect
  //                        enum / boolean / number types and defaults; required fields must be filled;
  //                        return { action: "accept", content } with properly typed values.
  // Until then this host declines everything it is asked, which is a legal (if unhelpful) answer.
  say(dim("  (this host cannot answer yet: TODO 2) → declining"));
  return { action: "decline" };
}

// Sampling: the server wants to borrow "our model". This host has no model, so it answers with a stub
// and shows you what was asked. In Module 8 you will see why the spec is retiring this channel.
async function sample(from: string, p: CreateMessageRequestParams): Promise<CreateMessageResult> {
  const last = p.messages.at(-1);
  const asked = last && !Array.isArray(last.content) && last.content.type === "text" ? last.content.text : JSON.stringify(last?.content);
  say(magenta(`\n  ${from} wants our model to answer: "${asked}" (maxTokens ${p.maxTokens})`));
  const reply = await rl.question("  Type the model's reply (Enter for a canned one): ");
  return { model: "course-host/human-in-the-loop", role: "assistant", content: { type: "text", text: reply.trim() || `Welcome aboard! We are glad you are joining us on Monday; your laptop and accounts are ready. (canned reply from ${process.env.USER ?? "the host"})` } };
}

// ---------------------------------------------------------------------------------------------
// One Client per server, exactly like OpenCode. Declare, handle, connect, catalogue.
// ---------------------------------------------------------------------------------------------
async function connect(name: string, cfg: ServerConfig) {
  const client = new Client({ name: "course-host", version: "1.0.0" }, { capabilities: CAPABILITIES });
  // You may only handle what you declared (the SDK refuses otherwise), and you must handle what you declared.
  // TODO 1: if (CAPABILITIES.roots) client.setRequestHandler("roots/list", async () => ({ roots: [{ uri: `file://${process.cwd()}`, name: "project" }] }));
  if (CAPABILITIES.elicitation) client.setRequestHandler("elicitation/create", async (req) => elicit(name, req.params)); // TODO 2
  if (CAPABILITIES.sampling) client.setRequestHandler("sampling/createMessage", async (req) => sample(name, req.params));
  client.setNotificationHandler("notifications/message", async (n) => say(dim(`  [${name} ${n.params.level}] ${typeof n.params.data === "string" ? n.params.data : JSON.stringify(n.params.data)}`)));
  // TODO 4: when a server says its tools changed, fetch the list again (and re-check the pins):
  //   client.setNotificationHandler("notifications/tools/list_changed", async () => refreshTools(name, client, "the server said its tools changed"));

  const transport = cfg.type === "local"
    ? new StdioClientTransport({ command: cfg.command[0], args: cfg.command.slice(1), env: { ...(process.env as Record<string, string>), ...cfg.environment }, stderr: "pipe" })
    : new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, subst(v)])) } });
  await client.connect(transport);
  if (transport instanceof StdioClientTransport) transport.stderr?.on("data", (d: Buffer) => { for (const line of d.toString().split("\n")) if (line.trim()) say(dim(`  ${name}› ${line}`)); });
  servers.set(name, { client, cfg });
  const v = client.getServerVersion();
  say(`${green("●")} ${bold(name)} ${dim(`${v?.name ?? "?"} ${v?.version ?? ""} · protocol ${client.getNegotiatedProtocolVersion()} · offers ${Object.keys(client.getServerCapabilities() ?? {}).join(", ") || "nothing"}`)}`);
  await refreshTools(name, client, "connected");
}

// ---------------------------------------------------------------------------------------------
// Calling a tool: permission check, progress, cancellation, and rendering the result.
// ---------------------------------------------------------------------------------------------
const glyphs = (t: Tool) => { const a = t.annotations ?? {}; return [a.readOnlyHint ? "read-only" : "writes", a.readOnlyHint ? null : a.destructiveHint === false ? "non-destructive" : "may destroy", a.idempotentHint ? "idempotent" : null, a.openWorldHint === false ? "closed-world" : null].filter(Boolean).join(" · "); };

function drawProgress(p: { progress: number; total?: number; message?: string }) {
  const total = p.total ?? 0, width = 24;
  const bar = total ? "█".repeat(Math.round((p.progress / total) * width)).padEnd(width, "░") : "·".repeat(Math.min(width, p.progress));
  process.stdout.write(`\r  ${cyan(bar)} ${total ? `${p.progress}/${total}` : p.progress} ${dim(p.message ?? "")}\x1b[K`);
  if (total && p.progress >= total) process.stdout.write("\n");
}

function printResult(r: CallToolResult) {
  const head = r.isError ? red("  tool error:") : green("  result:");
  for (const c of r.content) {
    if (c.type === "text") say(`${head} ${c.text}`);
    else if (c.type === "image" || c.type === "audio") say(`${head} [${c.type} ${c.mimeType}, ${Math.round(c.data.length * 0.75)} bytes]`);
    else if (c.type === "resource_link") say(`${head} [link] ${c.name} ${c.uri}`);
    else if (c.type === "resource") say(`${head} [resource ${c.resource.uri}] ${"text" in c.resource ? c.resource.text.slice(0, 300) : "(binary)"}`);
  }
  if (r.structuredContent) say(dim(`  structured: ${JSON.stringify(r.structuredContent)}`));
}

async function call(key: string, argsJson: string) {
  const e = catalog.get(key);
  if (!e) { say(red(`  no such tool: ${key} (try \`tools\`)`)); return; }
  let args: Record<string, unknown> = {};
  try { args = argsJson.trim() ? JSON.parse(argsJson) : {}; } catch { say(red("  arguments must be JSON, e.g. {\"employee\":\"Dana Ruiz\"}")); return; }
  if (e.status === "changed") { say(red(`  refusing: ${key}'s definition changed since you pinned it. \`trust ${key}\` after reviewing it.`)); return; }
  // The permission layer. OpenCode would consult your permission rules here; this host asks before
  // anything that is not marked read-only. The hint came from the server: you chose to believe it.
  const a = e.tool.annotations ?? {};
  if (a.readOnlyHint !== true) {
    const ans = await rl.question(`  ${key} ${a.destructiveHint === false ? "writes" : "may be destructive"}. Run it? [y/N] `);
    if (!/^y/i.test(ans)) { say(dim("  not called")); return; }
  }
  // TODO 3 · progress and cancellation. Set `inflight = new AbortController()` and pass
  //   { signal: inflight.signal, onprogress: drawProgress, resetTimeoutOnProgress: true } to callTool,
  //   so the server gets a progressToken, the bar draws, and ctrl+c sends notifications/cancelled.
  //   Clear `inflight` in a finally block, and report a cancelled call instead of a protocol error.
  const t0 = Date.now();
  try {
    const result = await e.client.callTool({ name: e.tool.name, arguments: args }, { timeout: 10 * 60_000 });
    printResult(result as CallToolResult);
    say(dim(`  ${Date.now() - t0} ms`));
  } catch (err) {
    say(red(`  protocol error: ${(err as Error).message}`));
  }
}

// ---------------------------------------------------------------------------------------------
// The REPL.
// ---------------------------------------------------------------------------------------------
async function repl() {
  say(dim("\n  type `help` for commands. You are the model now.\n"));
  for (;;) {
    const line = (await rl.question(bold("host> "))).trim();
    const [cmd, ...rest] = line.split(/\s+/);
    const arg1 = rest[0], tail = line.slice(line.indexOf(cmd) + cmd.length).trim();
    try {
      switch (cmd) {
        case "": break;
        case "help": say("  servers · caps · tools [server] · call <server_tool> [json] · resources · read <server> <uri> · prompts · prompt <server> <name> [json] · trust <server_tool> · quit"); break;
        case "servers":
          for (const [name, { client }] of servers) { const v = client.getServerVersion(); say(`  ${bold(name)}  ${v?.name} ${v?.version}  protocol ${client.getNegotiatedProtocolVersion()}  capabilities ${JSON.stringify(client.getServerCapabilities())}`); if (client.getInstructions()) say(dim(`    instructions: ${client.getInstructions()!.slice(0, 160)}${client.getInstructions()!.length > 160 ? "…" : ""}`)); }
          break;
        case "caps": say(`  this host told every server at initialize: ${JSON.stringify(CAPABILITIES)}`); break;
        case "tools":
          for (const [key, e] of catalog) if (!arg1 || e.server === arg1) {
            const flag = e.status === "changed" ? red(" CHANGED") : e.status === "new" ? green(" new") : "";
            say(`  ${bold(key)}${flag}  ${dim(glyphs(e.tool))}  ${dim("#" + e.hash.slice(0, 8))}`);
            say(`      ${(e.tool.description ?? "").replace(/\s+/g, " ").slice(0, 150)}`);
            say(dim(`      args: ${Object.keys((e.tool.inputSchema as { properties?: object }).properties ?? {}).join(", ") || "none"}`));
          }
          break;
        case "call": if (!arg1) { say("  call <server_tool> [json]"); break; } await call(arg1, tail.slice(arg1.length)); break;
        case "trust": { const e = arg1 && catalog.get(arg1); if (!e) { say(red("  no such tool")); break; } pins[arg1] = e.hash; e.status = "pinned"; writeFileSync(LOCK, JSON.stringify(pins, null, 2) + "\n"); say(green(`  pinned ${arg1} at #${e.hash.slice(0, 8)}`)); break; }
        case "resources":
          for (const [name, { client }] of servers) if (client.getServerCapabilities()?.resources) {
            const { resources } = await client.listResources();
            for (const r of resources) say(`  ${bold(name)} ${r.uri}  ${dim(r.title ?? r.name)}  ${dim(r.mimeType ?? "")}`);
            const { resourceTemplates } = await client.listResourceTemplates().catch(() => ({ resourceTemplates: [] }));
            for (const t of resourceTemplates) say(`  ${bold(name)} ${t.uriTemplate}  ${dim("(template) " + (t.title ?? t.name))}`);
          }
          break;
        case "read": { const s = arg1 && servers.get(arg1); if (!s || !rest[1]) { say("  read <server> <uri>"); break; } const r = await s.client.readResource({ uri: rest[1] }); for (const c of r.contents) say("text" in c ? c.text : `[binary ${c.mimeType}]`); break; }
        case "prompts":
          for (const [name, { client }] of servers) if (client.getServerCapabilities()?.prompts) for (const p of (await client.listPrompts()).prompts) say(`  ${bold(name)} ${p.name}  ${dim(p.description ?? "")}  ${dim("args: " + (p.arguments ?? []).map((a) => a.name).join(", "))}`);
          break;
        case "prompt": { const s = arg1 && servers.get(arg1); if (!s || !rest[1]) { say("  prompt <server> <name> [json]"); break; } const r = await s.client.getPrompt({ name: rest[1], arguments: JSON.parse(tail.slice(arg1.length + 1 + rest[1].length).trim() || "{}") }); for (const m of r.messages) say(`  ${bold(m.role)}: ${m.content.type === "text" ? m.content.text : `[${m.content.type}]`}`); break; }
        case "quit": case "exit": await shutdown(); return;
        default: say(dim(`  unknown command ${cmd}; try help`));
      }
    } catch (err) { say(red(`  ${(err as Error).message}`)); }
  }
}

async function shutdown() {
  say(dim("\n  closing connections…"));
  await Promise.allSettled([...servers.values()].map((s) => s.client.close()));
  rl.close();
  process.exit(0);
}

say(bold("course-host") + dim(` · ${CONFIG_FILE} · capabilities ${JSON.stringify(CAPABILITIES)}`));
for (const [name, cfg] of Object.entries(config.servers)) {
  if (cfg.enabled === false) { say(dim(`○ ${name} disabled`)); continue; }
  try { await connect(name, cfg); } catch (e) { say(`${red("✗")} ${bold(name)} ${red((e as Error).message)}`); }
}
await repl();
