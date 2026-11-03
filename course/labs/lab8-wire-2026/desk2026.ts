// Lab 8 · The release desk on the 2026-07-28 wire.
//
//   npx tsx desk2026.ts            -> http://127.0.0.1:8792/mcp, with a live board in this terminal
//   npx tsx desk2026.ts --plain    -> one log line per event instead of the board
//
// Same desk as Module 6 (services, preflights, deploys, a freeze), served the way the current spec
// revision wants it: createMcpHandler answers every request from a FRESH McpServer, there are no
// sessions, and every request carries everything the server needs to know in its _meta envelope.
// 2025-era clients (OpenCode 1.x) are still served, statelessly, by the same handler.
//
// The TODOs turn a plain tool server into one that uses what the 2026 wire adds:
//   TODO 1  deploy asks the person for confirmation with an input_required result (MRTR)
//   TODO 2  the requestState that round-trips through the client is signed, and checked
//   TODO 3  a freeze or a deploy tells every listening client (subscriptions/listen)
//   TODO 4  tools/list carries a cache hint, so clients stop re-fetching it every turn
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import {
  McpServer, createMcpHandler, requireBearerAuth, OAuthError, OAuthErrorCode,
  inputRequired, inputResponse, acceptedContent, createRequestStateCodec,
  hostHeaderValidationResponse, originValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins,
  type AuthInfo, type ServerContext, type ClientCapabilities,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import * as board from "./board.ts";

const PORT = Number(process.env.PORT ?? 8792);
const SERVICES = ["web", "api", "payments"] as const;
const PREFLIGHT_STEPS = ["unit tests", "integration tests", "migration dry-run", "canary health", "error budget"];
const STEP_MS = Number(process.env.STEP_MS ?? 1200);
const TOOLS_LIST_TTL_MS = 60_000;

// Who is who: the Module 6 demo tokens. Module 9 replaces this table with real OAuth tokens.
const DEMO_TOKENS: Record<string, { user: string; scopes: string[] }> = {
  "alice-dev-token":     { user: "alice", scopes: ["releases:read"] },
  "bob-releaser-token":  { user: "bob",   scopes: ["releases:read", "releases:deploy"] },
  "carol-lead-token":    { user: "carol", scopes: ["releases:read", "releases:deploy", "releases:freeze"] },
};
const verifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = DEMO_TOKENS[token];
    if (!t) throw new OAuthError(OAuthErrorCode.InvalidToken, "unknown token");
    return { token, clientId: t.user, scopes: t.scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  },
};
const authGate = requireBearerAuth({ verifier, requiredScopes: ["releases:read"] });

// The shared desk: one copy for the process. Request instances come and go; this stays.
const now = () => new Date().toTimeString().slice(0, 5);
const desk: board.Desk = {
  services: { web: { version: "4.11.0", deployed_by: "carol", at: "09:12" }, api: { version: "2.30.1", deployed_by: "bob", at: "10:40" }, payments: { version: "7.2.4", deployed_by: "carol", at: "yesterday" } },
  freeze: null,
  preflights: [],
};
const stats: board.Stats = { legacy: 0, modern: 0, inputRequired: 0, tampered: 0, listeners: 0, cacheTtl: `${TOOLS_LIST_TTL_MS} ms` };
board.attach(() => ({ desk, stats }));

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const refuse = (t: string) => ({ isError: true, content: [{ type: "text" as const, text: t }] });
const who = (ctx: ServerContext) => ctx.http?.authInfo?.clientId ?? "unknown";
const can = (ctx: ServerContext, scope: string) => ctx.http?.authInfo?.scopes.includes(scope) ?? false;

// ---------------------------------------------------------------------------------------------
// The 2026 envelope. Every modern request says which revision it speaks, who the client is and
// what the client can do, in params._meta. A legacy request says none of that: it said it once, at
// initialize, to an instance that no longer exists. These helpers hide the difference.
// ---------------------------------------------------------------------------------------------
// The SDK lifts the reserved io.modelcontextprotocol/* keys out of _meta into ctx.mcpReq.envelope.
const envelope = (ctx: ServerContext) => (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>;
const era = (ctx: ServerContext): "2026-07-28" | "legacy" => (envelope(ctx)["io.modelcontextprotocol/protocolVersion"] ? "2026-07-28" : "legacy");
const clientCaps = (ctx: ServerContext): ClientCapabilities => (envelope(ctx)["io.modelcontextprotocol/clientCapabilities"] as ClientCapabilities | undefined) ?? {};
const clientName = (ctx: ServerContext) => { const c = envelope(ctx)["io.modelcontextprotocol/clientInfo"] as { name?: string; version?: string } | undefined; return c ? `${c.name ?? "?"} ${c.version ?? ""}`.trim() : "a 2025 client"; };

// TODO 2 · requestState is minted by the server, round-trips through the client, and comes back as
// attacker-controlled input. This codec signs it (HMAC) and rejects anything tampered or expired.
// The key is per process on purpose: a restart voids every pending confirmation. Nothing uses it yet.
type Pending = { user: string; service: string; version: string; nonce: string };
const codec = createRequestStateCodec<Pending>({ key: randomBytes(32), ttlSeconds: 120 });

// ---------------------------------------------------------------------------------------------
// The server. createMcpHandler calls this factory for every modern request and every legacy one.
// Nothing you keep inside survives the request: shared state lives in `desk` above.
// ---------------------------------------------------------------------------------------------
function buildServer(built: { era: "legacy" | "modern" }): McpServer {
  board.event("info", `fresh instance for one ${built.era} request`);
  const server = new McpServer(
    { name: "release-desk-2026", version: "2.0.0" },
    {
      instructions: "Shared release desk for the web, api and payments services, on the 2026 protocol. Deploys need a passing preflight for the same version, and a confirmation from the person.",
      capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } },
      // TODO 4 · cache hints: tell clients how long tools/list stays valid. Without this the SDK sends
      //          ttlMs: 0 and a well-behaved client re-fetches the catalogue on every turn:
      //   cacheHints: { "tools/list": { ttlMs: TOOLS_LIST_TTL_MS, cacheScope: "private" } },
      // TODO 2 · verify the signature before any handler sees the state:
      //   requestState: { verify: codec.verify },
    },
  );

  server.registerTool("whoami", {
    title: "Who am I?",
    description: "Show which person this request is authenticated as, which protocol revision and client sent it, and what the token allows.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (_a, ctx) => {
    const a = ctx.http?.authInfo;
    return text(`You are ${a?.clientId ?? "unknown"} (scopes: ${a?.scopes.join(", ") || "none"}), speaking ${era(ctx)} from ${clientName(ctx)}. Your host declares: ${JSON.stringify(clientCaps(ctx))}. Envelope keys on this request: ${Object.keys(envelope(ctx)).join(", ") || "none"}.`);
  });

  server.registerTool("release_status", {
    title: "Release status",
    description: "Current version of every service, who deployed it and when, and whether a deploy freeze is active. Use before planning any deploy.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => text(statusText()));

  // The same facts as a resource, so a 2026 client can subscribe to it (TODO 3).
  server.registerResource("status", "desk://status", { title: "Release desk status", description: "Live versions and freeze state", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ services: desk.services, freeze: desk.freeze }, null, 2) }],
  }));

  server.registerTool("run_preflight", {
    title: "Run preflight checks",
    description: "Run the five preflight checks for deploying a version of a service (several seconds; reports progress). Required before deploy. Read-only.",
    inputSchema: z.object({ service: z.enum(SERVICES).describe("Service to check"), version: z.string().regex(/^\d+\.\d+\.\d+$/).describe("Semantic version, e.g. '4.12.0'") }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ service, version }, ctx) => {
    const run: board.Run = { id: randomUUID(), user: who(ctx), service, version, step: 0, total: PREFLIGHT_STEPS.length, label: "starting", state: "running" };
    desk.preflights.push(run);
    const token = ctx.mcpReq._meta?.progressToken;
    board.event("call", `${run.user} → run_preflight ${service}@${version}`);
    for (const [i, label] of PREFLIGHT_STEPS.entries()) {
      if (ctx.mcpReq.signal.aborted) { run.state = "cancelled"; board.event("refused", `${run.user} cancelled preflight at ${i + 1}/${run.total}`); return refuse(`Preflight for ${service}@${version} cancelled at step ${i + 1}.`); }
      run.step = i; run.label = label; board.draw();
      if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: i, total: run.total, message: label } });
      await sleep(STEP_MS, ctx.mcpReq.signal);
    }
    run.step = run.total; run.state = "passed";
    board.event("ok", `${run.user} preflight ${service}@${version} passed`);
    return text(`Preflight for ${service}@${version}: all ${run.total} checks passed. Ready to deploy.`);
  });

  const Confirm = z.object({ confirm: z.boolean().describe("Yes, deploy it"), note: z.string().max(120).optional().describe("Optional note for the deploy log") });
  const deployTool = server.registerTool("deploy", {
    title: "Deploy a version",
    description: "Deploy a version of a service to production. Only after a passing run_preflight for the same version, and only when the user explicitly asks. The desk asks the person to confirm before anything changes.",
    inputSchema: z.object({ service: z.enum(SERVICES).describe("Service to deploy"), version: z.string().regex(/^\d+\.\d+\.\d+$/).describe("Semantic version, e.g. '4.12.0'") }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ service, version }, ctx) => {
    const user = who(ctx);
    if (!can(ctx, "releases:deploy")) { board.event("refused", `REFUSED ${user}: token lacks releases:deploy`); return refuse(`${user} cannot deploy: the token lacks releases:deploy.`); }
    if (desk.freeze) { board.event("refused", `REFUSED ${user}: freeze is active`); return refuse(`Deploys are frozen by ${desk.freeze.by}: ${desk.freeze.reason}`); }
    if (!desk.preflights.some((r) => r.service === service && r.version === version && r.state === "passed")) { board.event("refused", `REFUSED ${user}: no passing preflight for ${service}@${version}`); return refuse(`No passing preflight for ${service}@${version}. Run run_preflight first.`); }

    // TODO 1 · Ask the person, through the protocol. Round one has no inputResponses: answer with an
    //          input_required result instead of a result. The client collects the answer and retries
    //          the same call with inputResponses (and our requestState) attached; round two lands here
    //          again with ctx.mcpReq.inputResponses set. See the guide, Exercise 8.C, for the shape.
    //          Refuse politely when the request is legacy (era(ctx) === "legacy": a stateless server
    //          cannot push a question) or when clientCaps(ctx).elicitation is missing.
    // TODO 2 · Sign the state with codec.mint({ user, service, version, nonce }), wire codec.verify
    //          into the server options, and on round two check ctx.mcpReq.requestState<Pending>()
    //          names the same user, service and version as the arguments. Exercise 8.D.
    const before = desk.services[service].version;
    desk.services[service] = { version, deployed_by: user, at: now() };
    board.event("write", `✎ DEPLOY ${service} ${before} → ${version} by ${user}`);
    // TODO 3 · tell every listening client the status changed: mcp.notify.resourceUpdated("desk://status")
    return text(`Deployed ${service} ${before} → ${version} as ${user}.`);
  });

  server.registerTool("declare_freeze", {
    title: "Declare a deploy freeze",
    description: "Stop all deploys for everyone until the freeze is lifted. Only when the user explicitly asks.",
    inputSchema: z.object({ reason: z.string().min(3).max(200).describe("Why deploys are frozen") }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ reason }, ctx) => {
    const user = who(ctx);
    if (!can(ctx, "releases:freeze")) return refuse(`${user} cannot declare a freeze: the token lacks releases:freeze.`);
    desk.freeze = { by: user, reason, at: now() };
    board.event("write", `❄ FREEZE declared by ${user}: ${reason}`);
    // TODO 3 · There are no sessions to walk any more (compare Module 6's setDeployAvailable). Publish
    //          the change to every open subscriptions/listen stream instead:
    //            mcp.notify.toolsChanged(); mcp.notify.resourceUpdated("desk://status");
    //          and log it: board.event("notify", "tools/list_changed + resources/updated published to every listener");
    return text(`Freeze declared by ${user}. Deploys are refused until it is lifted.`);
  });

  server.registerTool("lift_freeze", {
    title: "Lift the deploy freeze",
    description: "Lift an active deploy freeze. Only when the user explicitly asks.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (_a, ctx) => {
    const user = who(ctx);
    if (!can(ctx, "releases:freeze")) return refuse(`${user} cannot lift the freeze: the token lacks releases:freeze.`);
    if (!desk.freeze) return text("There is no freeze to lift.");
    desk.freeze = null;
    board.event("write", `☀ freeze lifted by ${user}`);
    // TODO 3 · same two notifications as declare_freeze
    return text(`Freeze lifted by ${user}. Deploys are open again.`);
  });

  if (desk.freeze) deployTool.disable(); // this instance serves one request; the list it answers with is honest for now
  return server;
}
const statusText = () => [...Object.entries(desk.services).map(([id, s]) => `${id}: ${s.version} (deployed by ${s.deployed_by} at ${s.at})`), desk.freeze ? `FREEZE active since ${desk.freeze.at}, set by ${desk.freeze.by}: ${desk.freeze.reason}` : "No freeze: deploys are open."].join("\n");

// One handler for both eras. Modern requests get a fresh instance each; legacy requests are served
// statelessly too (GET and DELETE answer 405: there is no session to stream to or to end).
const mcp = createMcpHandler((fctx) => buildServer({ era: fctx.era }), { legacy: "stateless", onerror: (e) => board.event("refused", `handler: ${e.message}`) });

// ---------------------------------------------------------------------------------------------
// HTTP. Validate Host/Origin, authenticate, then hand the request to the handler. The board reads
// the headers the 2026 wire mirrors from the body, so a proxy could route on them without parsing JSON.
// ---------------------------------------------------------------------------------------------
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
  const rejected = hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins());
  if (rejected) { board.event("auth", `rejected Host/Origin ${request.headers.get("host")} ${request.headers.get("origin") ?? ""}`); return rejected; }
  const auth = await authGate(request);
  if (auth instanceof Response) { board.event("auth", `401 ${request.method} without a valid token`); return auth; }

  const h = (n: string) => request.headers.get(n);
  const modern = !!h("mcp-method") || h("mcp-protocol-version") === "2026-07-28";
  let bodyMethod = "";
  if (request.method === "POST") { try { const b = await request.clone().json(); bodyMethod = b?.method ?? ""; } catch { /* not JSON */ } }
  if (request.method === "POST") { if (modern) stats.modern++; else stats.legacy++; }
  board.event("rpc", `${auth.clientId} ${request.method} ${modern ? `${h("mcp-method")}${h("mcp-name") ? " " + h("mcp-name") : ""}  [${h("mcp-protocol-version")}, header-routed]` : `${bodyMethod || "(stream)"}  [legacy${h("mcp-protocol-version") ? " " + h("mcp-protocol-version") : ""}]`}`);
  const response = await mcp.fetch(request, { authInfo: auth });
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try { const j = await response.clone().json(); const r = j?.result; if (j?.error) board.event("refused", `← ${response.status} error ${j.error.code}: ${j.error.message}`); else board.event("http", `← ${response.status} json${r?.resultType ? ` resultType=${r.resultType}` : ""}${r?.ttlMs !== undefined ? ` ttlMs=${r.ttlMs} cacheScope=${r.cacheScope}` : ""}`); } catch { board.event("http", `← ${response.status}`); }
  } else if (ct.includes("text/event-stream")) {
    board.event("http", `← ${response.status} event-stream${bodyMethod === "subscriptions/listen" ? " (subscriptions/listen: held open)" : ""}`);
    if (bodyMethod === "subscriptions/listen") { stats.listeners++; board.draw(); const body = response.body!.pipeThrough(new TransformStream({ flush() { stats.listeners = Math.max(0, stats.listeners - 1); board.event("info", "a listen stream closed"); } })); return new Response(body, { status: response.status, headers: response.headers }); }
  } else board.event("http", `← ${response.status}`);
  return response;
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
  const reader = r.body.getReader();
  res.on("close", () => { reader.cancel().catch(() => {}); });
  for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
  res.end();
}
const http = createServer(async (req, res) => {
  try { await send(res, await handle(await toRequest(req))); }
  catch (e) { board.event("refused", `500 ${(e as Error).message}`); if (!res.headersSent) res.writeHead(500).end(String(e)); else res.end(); }
});
http.listen(PORT, "127.0.0.1", () => {
  board.start(() => { void mcp.close(); http.close(); });
  board.event("info", `listening on http://127.0.0.1:${PORT}/mcp · demo tokens: alice-dev-token (read) · bob-releaser-token (deploy) · carol-lead-token (freeze)`);
});
