// Lab 10 · The MCP gateway: one door for every server.
//
//   npx tsx gateway.ts            -> http://127.0.0.1:8800/mcp, with a live board in this terminal
//   npx tsx gateway.ts --plain    -> one log line per event instead
//
// The gateway is an MCP SERVER to the agents in front of it and an MCP CLIENT to the servers behind
// it (upstreams.json). It starts every upstream itself, so their credentials live in this process and
// nowhere else; it re-publishes their tools under one namespaced catalogue; and every call passes
// through four checks on the way in and out. That is where a company's MCP policy can live once,
// instead of in every laptop's opencode.json:
//   TODO 1  policy: who may call which tool, with which arguments (policy.json)
//   TODO 2  screening and pinning: a poisoned description, or a changed one, is quarantined
//   TODO 3  redaction: secrets in upstream results never reach the model
//   TODO 4  audit: one line per decision, with a trace id the upstream sees too
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  McpServer, createMcpHandler, requireBearerAuth, OAuthError, OAuthErrorCode, fromJsonSchema,
  hostHeaderValidationResponse, originValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins,
  type AuthInfo, type ServerContext, type CallToolResult, type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { Client, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as z from "zod/v4";
import * as board from "./board.ts";

const PORT = Number(process.env.PORT ?? 8800);
const HERE = new URL(".", import.meta.url).pathname;
const PINS = HERE + "pins.json";
const AUDIT = HERE + "audit.jsonl";
type Upstream = { command: string[]; cwd?: string; env?: Record<string, string> };
const { upstreams: UPSTREAMS } = JSON.parse(readFileSync(HERE + "upstreams.json", "utf8")) as { upstreams: Record<string, Upstream> };
type Rule = { tool: string; allow?: string[]; deny?: string[]; args?: Record<string, string>; note?: string };
const POLICY = JSON.parse(readFileSync(HERE + "policy.json", "utf8")) as { people: Record<string, { user: string; groups: string[] }>; rules: Rule[] };

// ---------------------------------------------------------------------------------------------
// Front door: who is calling. Module 9 shows how to replace this table with OAuth; the gateway is
// then the ONE resource server every agent needs a token for.
// ---------------------------------------------------------------------------------------------
const verifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const p = POLICY.people[token];
    if (!p) throw new OAuthError(OAuthErrorCode.InvalidToken, "unknown token");
    return { token, clientId: p.user, scopes: p.groups, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  },
};
const authGate = requireBearerAuth({ verifier });
const who = (ctx: ServerContext) => ctx.http?.authInfo?.clientId ?? "unknown";
const groups = (ctx: ServerContext) => ctx.http?.authInfo?.scopes ?? [];

// ---------------------------------------------------------------------------------------------
// The catalogue: every upstream tool, namespaced upstream_tool, with its pin status.
// ---------------------------------------------------------------------------------------------
type Entry = { key: string; upstream: string; tool: Tool; hash: string; quarantine?: string };
const catalog = new Map<string, Entry>();
const clients = new Map<string, Client>();
const rows = new Map<string, board.UpstreamRow>();
const stats: board.Stats = { calls: 0, allowed: 0, denied: 0, quarantined: 0, redactions: 0, audited: 0 };
let pins: Record<string, string> = existsSync(PINS) ? JSON.parse(readFileSync(PINS, "utf8")) : {};
board.attach(() => ({
  upstreams: [...rows.values()].map((r) => ({ ...r, quarantined: [...catalog.values()].filter((e) => e.upstream === r.name && e.quarantine).length })),
  quarantine: [...catalog.values()].filter((e) => e.quarantine).map((e) => ({ key: e.key, reason: e.quarantine! })),
  stats: { ...stats, quarantined: [...catalog.values()].filter((e) => e.quarantine).length },
}));
const hashTool = (t: Tool) => createHash("sha256").update(JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })).digest("hex").slice(0, 12);

// TODO 2 · Screening. A description is a prompt: the model reads every word. These are the shapes
//          Module 4's poisoned tools used. A match quarantines the tool before any agent sees it.
const SUSPICIOUS: [RegExp, string][] = [
  [/<\s*important\s*>/i, "hidden <IMPORTANT> block"],
  [/do not (mention|tell|reveal)|without telling the user/i, "asks the model to hide something from the user"],
  [/\.env\b|id_rsa|\.ssh\b|credentials?\s+file/i, "points the model at secret files"],
  [/ignore (all |any )?(previous|prior) instructions/i, "tries to override instructions"],
];
function screen(t: Tool): string | undefined {
  // TODO 2a: test `${t.description} ${JSON.stringify(t.inputSchema)}` against every SUSPICIOUS pattern
  //          and return "description " + the reasons that matched (or undefined when none did).
  void t; void SUSPICIOUS;
  return undefined;
}

async function refresh(name: string, why: string) {
  const client = clients.get(name)!;
  const { tools } = await client.listTools();
  for (const [k, e] of catalog) if (e.upstream === name) catalog.delete(k);
  for (const tool of tools) {
    const key = `${name}_${tool.name}`;
    const hash = hashTool(tool);
    let quarantine: string | undefined;
    // TODO 2 · Pinning: first sight of a clean tool → pin it. Later, a different hash → quarantine it
    //          until a lead reviews the change (gateway_review). A suspicious one is never pinned.
    // TODO 2b: const suspicious = screen(tool); and a `changed` reason when key is pinned at another
    //          hash. Either one sets `quarantine`. Only a clean, unpinned tool gets pinned.
    if (!(key in pins)) { pins[key] = hash; board.event("pin", `pinned ${key} #${hash}`); }
    if (quarantine) board.event("quarantine", `QUARANTINED ${key}: ${quarantine}`);
    catalog.set(key, { key, upstream: name, tool, hash, quarantine });
  }
  writeFileSync(PINS, JSON.stringify(pins, null, 2) + "\n");
  const row = rows.get(name)!; row.tools = tools.length; row.status = "up";
  board.event("up", `${name}: ${tools.length} tools (${why})`);
  mcp.notify.toolsChanged(); // 2026 clients listening on subscriptions/listen re-fetch at once
}

async function connectUpstream(name: string, u: Upstream) {
  rows.set(name, { name, status: "starting", tools: 0, quarantined: 0, server: "" });
  // The gateway is a client with no human attached, so it declares no capabilities: an upstream that
  // wants to ask the user (elicitation) takes its fallback path and tells the model instead.
  const client = new Client({ name: "mcp-gateway", version: "1.0.0" });
  client.setNotificationHandler("notifications/tools/list_changed", async () => { board.event("quarantine", `${name} says its tools changed (notifications/tools/list_changed)`); await refresh(name, "list_changed"); });
  const transport = new StdioClientTransport({ command: u.command[0], args: u.command.slice(1), cwd: u.cwd ? new URL(u.cwd, `file://${HERE}`).pathname : HERE, env: { ...(process.env as Record<string, string>), ...u.env }, stderr: "pipe" });
  try {
    await client.connect(transport);
    clients.set(name, client);
    const v = client.getServerVersion();
    rows.get(name)!.server = `${v?.name ?? "?"} ${v?.version ?? ""}`;
    await refresh(name, "connected");
  } catch (e) { rows.get(name)!.status = "down"; board.event("deny", `${name} failed to start: ${(e as Error).message}`); }
}

// ---------------------------------------------------------------------------------------------
// TODO 1 · Policy. Last matching rule wins; no match means deny. A rule may also constrain arguments
//          with regular expressions, which is something no client-side permission rule can do.
// ---------------------------------------------------------------------------------------------
const glob = (pattern: string, s: string) => new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(s);
type Decision = { allow: boolean; reason: string };
function decide(user: string, userGroups: string[], key: string, args: Record<string, unknown>): Decision {
  // TODO 1: walk POLICY.rules top to bottom; for each rule whose `tool` glob matches `key`:
  //   - the user is in `deny` (or deny has "*")          → this rule says deny
  //   - the user is not in `allow`                        → this rule says deny ("<user> is not in <groups>")
  //   - an `args` regex (case-insensitive) does not match → this rule says deny ("argument sql must match …")
  //   - otherwise                                         → this rule says allow
  // The LAST matching rule wins; no matching rule means deny.
  void user; void userGroups; void key; void args; void glob;
  return { allow: true, reason: "no policy yet: everything is allowed" };
}

// ---------------------------------------------------------------------------------------------
// TODO 3 · Redaction. Upstream results go to the model, and from the model to its provider. Replace
// anything shaped like a secret, and mask customer e-mail addresses for everyone but leads.
// ---------------------------------------------------------------------------------------------
const SECRETS: [RegExp, string][] = [
  [/tdb_admin_[A-Za-z0-9_]+/g, "[REDACTED:teamdb-admin-token]"],
  [/\b(sk|ghp|xox[bp]|AKIA)[-_A-Za-z0-9]{12,}\b/g, "[REDACTED:api-key]"],
  [/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, "$1[REDACTED]"],
];
function redact(text: string, userGroups: string[]): { text: string; n: number } {
  // TODO 3: apply every SECRETS pattern (count each replacement in n), then, unless userGroups has
  //         "lead", mask e-mail addresses to their first letter: ada@analytical.example → a***@analytical.example
  void SECRETS; void userGroups;
  return { text, n: 0 };
}

// ---------------------------------------------------------------------------------------------
// TODO 4 · Audit. One JSON line per call: who, what, which decision and why, how long, how big, and a
// trace id. The trace id also travels to the upstream in _meta.traceparent (W3C Trace Context, the
// key SEP-414 reserves), so the upstream's own logs can be joined to this line.
// ---------------------------------------------------------------------------------------------
function audit(line: Record<string, unknown>) {
  // TODO 4: append JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n" to AUDIT and count it in stats.audited.
  void line; void appendFileSync; void AUDIT;
}

// ---------------------------------------------------------------------------------------------
// The front: a fresh McpServer per request that re-publishes the catalogue as this person sees it.
// ---------------------------------------------------------------------------------------------
function buildServer(ctx0: { authInfo?: AuthInfo }): McpServer {
  const server = new McpServer({ name: "mcp-gateway", version: "1.0.0" }, {
    instructions: "One gateway in front of the team's MCP servers. Tool names are upstream_tool. Refusals come from the gateway's policy, not from the upstream.",
    capabilities: { tools: { listChanged: true } },
  });
  const user = ctx0.authInfo?.clientId ?? "unknown", userGroups = ctx0.authInfo?.scopes ?? [];

  for (const e of catalog.values()) {
    if (e.quarantine) continue; // a quarantined tool is not offered to anyone (TODO 2)
    // Show people only what they may use (Challenge 6B); the call path checks again anyway.
    if (!decide(user, userGroups, e.key, {}).allow && !POLICY.rules.some((r) => r.args && glob(r.tool, e.key))) continue;
    server.registerTool(e.key, {
      title: e.tool.title, description: `[${e.upstream}] ${e.tool.description ?? ""}`,
      inputSchema: fromJsonSchema<Record<string, unknown>>(e.tool.inputSchema as JsonSchemaType), annotations: e.tool.annotations,
    }, async (args, ctx) => proxy(e.key, args, ctx));
  }

  server.registerTool("gateway_status", {
    title: "Gateway status", description: "Which upstream servers the gateway fronts, how many tools each has, and which tools are quarantined and why.",
    inputSchema: z.object({}), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => ({ content: [{ type: "text", text: [...rows.values()].map((r) => `${r.name}: ${r.status}, ${r.tools} tools (${r.server})`).concat([...catalog.values()].filter((e) => e.quarantine).map((e) => `QUARANTINED ${e.key}: ${e.quarantine}`)).join("\n") }] }));

  if (decide(user, userGroups, "gateway_review", {}).allow) server.registerTool("gateway_review", {
    title: "Review a quarantined tool", description: "Show a quarantined tool's full current definition, or release it (approve: true) so it is pinned at its current definition and offered again. Leads only.",
    inputSchema: z.object({ tool: z.string().describe("Namespaced tool, e.g. release_get_release_notes"), approve: z.boolean().default(false) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ tool, approve }, ctx) => {
    const e = catalog.get(tool);
    if (!e?.quarantine) return { isError: true, content: [{ type: "text", text: `${tool} is not in quarantine.` }] };
    if (!approve) return { content: [{ type: "text", text: `${tool} is quarantined: ${e.quarantine}\n\nCurrent definition:\n${JSON.stringify(e.tool, null, 2)}` }] };
    pins[tool] = e.hash; e.quarantine = undefined; writeFileSync(PINS, JSON.stringify(pins, null, 2) + "\n");
    board.event("pin", `${who(ctx)} released ${tool} from quarantine, pinned at #${e.hash}`);
    audit({ trace: randomBytes(16).toString("hex"), user: who(ctx), tool: "gateway_review", target: tool, decision: "release" });
    mcp.notify.toolsChanged();
    return { content: [{ type: "text", text: `${tool} released and pinned at #${e.hash}.` }] };
  });
  return server;
}

async function proxy(key: string, args: Record<string, unknown>, ctx: ServerContext): Promise<CallToolResult> {
  const user = who(ctx), userGroups = groups(ctx), e = catalog.get(key);
  const trace = randomBytes(16).toString("hex"), t0 = Date.now();
  const argsPreview = redact(JSON.stringify(args), ["lead"]).text.slice(0, 200);
  const base = { trace, user, tool: key, upstream: e?.upstream, args_sha256: createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16), args: argsPreview };
  stats.calls++;
  board.event("call", `${user} → ${key} ${argsPreview.slice(0, 80)}`);
  if (!e || e.quarantine) { stats.denied++; audit({ ...base, decision: "deny", reason: e ? `quarantined: ${e.quarantine}` : "unknown tool" }); board.event("deny", `DENY ${user} ${key}: ${e ? "quarantined" : "unknown tool"}`); return { isError: true, content: [{ type: "text", text: `The gateway refused ${key}: ${e ? `it is quarantined (${e.quarantine}). A lead must review it first.` : "no such tool."}` }] }; }
  const d = decide(user, userGroups, key, args);
  if (!d.allow) { stats.denied++; audit({ ...base, decision: "deny", reason: d.reason }); board.event("deny", `DENY ${user} ${key}: ${d.reason}`); return { isError: true, content: [{ type: "text", text: `The gateway's policy refused ${key} for ${user}: ${d.reason}.` }] }; }
  stats.allowed++;
  try {
    const r = (await clients.get(e.upstream)!.callTool({ name: e.tool.name, arguments: args, _meta: { traceparent: `00-${trace}-${randomBytes(8).toString("hex")}-01` } }, { timeout: 120_000, signal: ctx.mcpReq.signal })) as CallToolResult;
    let redactions = 0;
    const content = r.content.map((c) => { if (c.type !== "text") return c; const x = redact(c.text, userGroups); redactions += x.n; return { ...c, text: x.text }; });
    if (redactions) { stats.redactions += redactions; board.event("redact", `redacted ${redactions} value${redactions === 1 ? "" : "s"} from ${key} for ${user}`); }
    const bytes = JSON.stringify(content).length;
    audit({ ...base, decision: "allow", reason: d.reason, ms: Date.now() - t0, result_bytes: bytes, is_error: !!r.isError, redactions });
    board.event("allow", `ALLOW ${user} ${key} · ${Date.now() - t0} ms · ${bytes} B${r.isError ? " · upstream isError" : ""}`);
    return { content, isError: r.isError }; // structuredContent is dropped on purpose: it was not redacted
  } catch (err) {
    audit({ ...base, decision: "allow", reason: d.reason, ms: Date.now() - t0, error: (err as Error).message });
    return { isError: true, content: [{ type: "text", text: `Upstream ${e.upstream} failed: ${(err as Error).message}` }] };
  }
}

const mcp = createMcpHandler((fctx) => buildServer({ authInfo: fctx.authInfo }), { legacy: "stateless", onerror: (e) => board.event("deny", `handler: ${e.message}`) });

async function handle(request: Request): Promise<Response> {
  if (new URL(request.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
  const rejected = hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins());
  if (rejected) return rejected;
  const auth = await authGate(request);
  if (auth instanceof Response) { board.event("deny", `401 ${request.method} without a valid token`); return auth; }
  return mcp.fetch(request, { authInfo: auth });
}
async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
  return new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}
async function send(res: ServerResponse, r: Response) {
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (!r.body) { res.end(); return; }
  const reader = r.body.getReader(); res.on("close", () => { reader.cancel().catch(() => {}); });
  for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); } res.end();
}

board.start(() => { for (const c of clients.values()) void c.close(); });
await Promise.all(Object.entries(UPSTREAMS).map(([n, u]) => connectUpstream(n, u)));
createServer(async (req, res) => { try { await send(res, await handle(await toRequest(req))); } catch (e) { board.event("deny", `500 ${(e as Error).message}`); if (!res.headersSent) res.writeHead(500).end(String(e)); else res.end(); } })
  .listen(PORT, "127.0.0.1", () => board.event("info", `listening on http://127.0.0.1:${PORT}/mcp · ${catalog.size} upstream tools · tokens: alice-dev-token, bob-releaser-token, carol-lead-token`));
