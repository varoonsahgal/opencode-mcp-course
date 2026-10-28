// Lab 6 · The release desk: a Streamable HTTP MCP server that several people share.
//
//   npx tsx server.ts            -> http://127.0.0.1:8790/mcp, with a live ops board in this terminal
//   npx tsx server.ts --plain    -> one log line per event instead of the board
//
// Unlike every server so far, nobody spawns this one: it runs on its own, and any number of
// MCP clients connect to it over HTTP. Each client gets its own MCP *session*; all sessions share
// one desk (the services, the deploy history, the freeze). The bearer token on every request
// says who is calling.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  McpServer, WebStandardStreamableHTTPServerTransport, requireBearerAuth, isInitializeRequest, OAuthError, OAuthErrorCode,
  hostHeaderValidationResponse, originValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins,
  type AuthInfo, type RegisteredTool,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import * as board from "./board.ts";

const PORT = Number(process.env.PORT ?? 8790);
const SERVICES = ["web", "api", "payments"] as const;
const PREFLIGHT_STEPS = ["unit tests", "integration tests", "migration dry-run", "canary health", "error budget"];
const STEP_MS = Number(process.env.STEP_MS ?? 1200);

// ---------------------------------------------------------------------------------------------
// Who is who. In production these come from your identity provider (OAuth, Module 6.2); here a
// fixed table keeps the lab offline. Scopes are what a token may do, decided by the org, not by
// the person or the model.
// ---------------------------------------------------------------------------------------------
const DEMO_TOKENS: Record<string, { user: string; scopes: string[] }> = {
  "alice-dev-token":     { user: "alice", scopes: ["releases:read"] },
  "bob-releaser-token":  { user: "bob",   scopes: ["releases:read", "releases:deploy"] },
  "carol-lead-token":    { user: "carol", scopes: ["releases:read", "releases:deploy", "releases:freeze"] },
};

// TODO 4 (rotate and hash): these tokens sit in plain text in the project, next to everything
// else that runs as you. Replace this table with hashes loaded from tokens.json (written by
// `node issue-tokens.mjs`), and make the server refuse to start without that file. Exercise 6.F.
const verifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = DEMO_TOKENS[token];
    if (!t) throw new OAuthError(OAuthErrorCode.InvalidToken, "unknown token"); // requireBearerAuth answers 401 + WWW-Authenticate
    return { token, clientId: t.user, scopes: t.scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  },
};
const authGate = requireBearerAuth({ verifier, requiredScopes: ["releases:read"] });

// ---------------------------------------------------------------------------------------------
// The shared desk. One copy for the whole process: every session reads and writes it.
// ---------------------------------------------------------------------------------------------
const now = () => new Date().toTimeString().slice(0, 5);
const desk: board.Desk = {
  services: {
    web:      { version: "4.11.0", deployed_by: "carol", at: "09:12" },
    api:      { version: "2.30.1", deployed_by: "bob",   at: "10:40" },
    payments: { version: "7.2.4",  deployed_by: "carol", at: "yesterday" },
  },
  freeze: null,
  preflights: [],
};

type Live = { transport: WebStandardStreamableHTTPServerTransport; server: McpServer; user: string; client: string; protocol: string; since: number; streams: number; deployTool?: RegisteredTool };
const sessions = new Map<string, Live>();
board.attach(() => ({ desk, sessions: [...sessions.entries()].map(([id, s]) => ({ id, user: s.user, client: s.client, protocol: s.protocol, since: s.since, streams: s.streams })) }));

// A wait that ends early when the client cancels, so a cancelled call stops at once.
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const refuse = (t: string) => ({ isError: true, content: [{ type: "text" as const, text: t }] });
const who = (ctx: { http?: { authInfo?: AuthInfo } }) => ctx.http?.authInfo?.clientId ?? "unknown";
const can = (ctx: { http?: { authInfo?: AuthInfo } }, scope: string) => ctx.http?.authInfo?.scopes.includes(scope) ?? false;

// ---------------------------------------------------------------------------------------------
// The MCP server: one instance per session, built by this factory when a client initializes.
// ---------------------------------------------------------------------------------------------
function buildServer(): { server: McpServer; deployTool: RegisteredTool } {
  const server = new McpServer(
    { name: "release-desk", version: "1.0.0" },
    { instructions: "Shared release desk for the web, api and payments services. Deploys require a passing preflight for the same version." },
  );

  server.registerTool("whoami", {
    title: "Who am I?",
    description: "Show which person this session is authenticated as and what their token allows. Use it when the user asks who they are logged in as or what they are allowed to do on the release desk.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (_args, ctx) => {
    const a = ctx.http?.authInfo;
    return text(`You are ${a?.clientId ?? "unknown"}. Scopes: ${a?.scopes.join(", ") || "none"}.`);
  });

  server.registerTool("release_status", {
    title: "Release status",
    description: "Current version of every service, who deployed it and when, and whether a deploy freeze is active. Use it before planning any deploy.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const lines = Object.entries(desk.services).map(([id, s]) => `${id}: ${s.version} (deployed by ${s.deployed_by} at ${s.at})`);
    lines.push(desk.freeze ? `FREEZE active since ${desk.freeze.at}, set by ${desk.freeze.by}: ${desk.freeze.reason}` : "No freeze: deploys are open.");
    return text(lines.join("\n"));
  });

  // TODO 2 (progress + cancellation) is in the loop below.
  server.registerTool("run_preflight", {
    title: "Run preflight checks",
    description: "Run the five preflight checks for deploying a version of a service (takes several seconds). A passing preflight is required before deploy. Read-only: it never changes what is running.",
    inputSchema: z.object({
      service: z.enum(SERVICES).describe("Service to check"),
      version: z.string().regex(/^\d+\.\d+\.\d+$/).describe("Semantic version to check, e.g. '4.12.0'"),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ service, version }, ctx) => {
    const run: board.Run = { id: randomUUID(), user: who(ctx), service, version, step: 0, total: PREFLIGHT_STEPS.length, label: "starting", state: "running" };
    desk.preflights.push(run);
    const token = ctx.mcpReq._meta?.progressToken;
    board.event("call", `${run.user} → run_preflight ${service}@${version}${token === undefined ? " (no progressToken)" : ` (progressToken ${token})`}`);
    for (const [i, label] of PREFLIGHT_STEPS.entries()) {
      // TODO 2a: if the client cancelled (ctx.mcpReq.signal.aborted), mark the run "cancelled",
      //          log it on the board and return an isError result. Do it before each step.
      run.step = i; run.label = label; board.draw();
      // TODO 2b: if the request carried a progressToken, send notifications/progress with
      //          { progressToken: token, progress: i, total: run.total, message: label }
      //          via ctx.mcpReq.notify(...), and log it with board.event("notify", ...).
      await new Promise((r) => setTimeout(r, STEP_MS)); // TODO 2c: use sleep(STEP_MS, ctx.mcpReq.signal) so a cancel ends the wait at once
    }
    run.step = run.total; run.state = "passed";
    board.event("ok", `${run.user} preflight ${service}@${version} passed`);
    return text(`Preflight for ${service}@${version}: all ${run.total} checks passed (${PREFLIGHT_STEPS.join(", ")}). Ready to deploy.`);
  });

  // TODO 1 (server-side authorization) is at the top of this handler.
  const deployTool = server.registerTool("deploy", {
    title: "Deploy a version",
    description: "Deploy a version of a service to production. Only call it when the user explicitly asks to deploy, after a passing run_preflight for the same service and version.",
    inputSchema: z.object({
      service: z.enum(SERVICES).describe("Service to deploy"),
      version: z.string().regex(/^\d+\.\d+\.\d+$/).describe("Semantic version, e.g. '4.12.0'"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ service, version }, ctx) => {
    const user = who(ctx);
    board.event("call", `${user} → deploy ${service}@${version}`);
    // TODO 1: refuse (and log a "refused" board event) unless the caller's token has the
    //         releases:deploy scope. can(ctx, "releases:deploy") tells you. Say who and why in the
    //         isError text, so the model can explain it to the user.
    if (desk.freeze) {
      board.event("refused", `REFUSED ${user}: freeze is active`);
      return refuse(`Deploys are frozen by ${desk.freeze.by}: ${desk.freeze.reason}`);
    }
    const passed = desk.preflights.some((r) => r.service === service && r.version === version && r.state === "passed");
    if (!passed) {
      board.event("refused", `REFUSED ${user}: no passing preflight for ${service}@${version}`);
      return refuse(`No passing preflight for ${service}@${version}. Run run_preflight first.`);
    }
    const before = desk.services[service].version;
    desk.services[service] = { version, deployed_by: user, at: now() };
    board.event("write", `✎ DEPLOY ${service} ${before} → ${version} by ${user}`);
    return text(`Deployed ${service} ${before} → ${version} as ${user}.`);
  });

  // TODO 3 (dynamic tools): both handlers already call setDeployAvailable(), which is empty. Fill it in.
  server.registerTool("declare_freeze", {
    title: "Declare a deploy freeze",
    description: "Stop all deploys for everyone until the freeze is lifted. Use only when the user explicitly asks to freeze deploys.",
    inputSchema: z.object({ reason: z.string().min(3).max(200).describe("Why deploys are frozen") }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ reason }, ctx) => {
    const user = who(ctx);
    if (!can(ctx, "releases:freeze")) { board.event("refused", `REFUSED ${user}: token lacks releases:freeze`); return refuse(`${user} cannot declare a freeze: the token lacks releases:freeze.`); }
    desk.freeze = { by: user, reason, at: now() };
    board.event("write", `❄ FREEZE declared by ${user}: ${reason}`);
    setDeployAvailable(false);
    return text(`Freeze declared by ${user}. Deploys are refused until it is lifted.`);
  });

  server.registerTool("lift_freeze", {
    title: "Lift the deploy freeze",
    description: "Lift an active deploy freeze so deploys are possible again. Use only when the user explicitly asks.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (_args, ctx) => {
    const user = who(ctx);
    if (!can(ctx, "releases:freeze")) { board.event("refused", `REFUSED ${user}: token lacks releases:freeze`); return refuse(`${user} cannot lift the freeze: the token lacks releases:freeze.`); }
    if (!desk.freeze) return text("There is no freeze to lift.");
    desk.freeze = null;
    board.event("write", `☀ freeze lifted by ${user}`);
    setDeployAvailable(true);
    return text(`Freeze lifted by ${user}. Deploys are open again.`);
  });

  if (desk.freeze) deployTool.disable(); // a session that connects during a freeze never sees deploy
  return { server, deployTool };
}

// Enable or disable `deploy` in every live session. Each change makes the SDK send
// notifications/tools/list_changed to that session's client, which then re-fetches tools/list.
function setDeployAvailable(on: boolean) {
  // TODO 3: for every live session s with an s.deployTool, call s.deployTool.enable() or
  //         s.deployTool.disable(), and log board.event("notify", `tools/list_changed → ${s.user} ...`).
  void on;
}

// ---------------------------------------------------------------------------------------------
// HTTP: one endpoint, /mcp. POST carries JSON-RPC from the client; the answer is JSON or an SSE
// stream. GET opens a stream for server-initiated messages. DELETE ends a session.
// ---------------------------------------------------------------------------------------------
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });

  // 1. DNS-rebinding protection: only localhost Host/Origin headers may talk to a localhost server.
  const rejected = hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins());
  if (rejected) { board.event("auth", `rejected Host/Origin ${request.headers.get("host")} ${request.headers.get("origin") ?? ""}`); return rejected; }

  // 2. Authentication: every request carries the token, not just the first one.
  const auth = await authGate(request);
  if (auth instanceof Response) { board.event("auth", `401 ${request.method} without a valid token`); return auth; }

  // 3. Session routing.
  const sid = request.headers.get("mcp-session-id");
  if (sid) {
    const s = sessions.get(sid);
    if (!s) {
      board.event("info", `${auth.clientId} used unknown session ${sid.slice(0, 8)} → 404, the client must initialize again`);
      return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, { status: 404 });
    }
    if (s.user !== auth.clientId) { board.event("auth", `${auth.clientId} tried to use ${s.user}'s session ${sid.slice(0, 8)}`); return new Response("session belongs to another user", { status: 403 }); }
    const body = request.method === "POST" ? await request.json() : undefined;
    if (body && !Array.isArray(body) && body.method) board.event("rpc", `${s.user} ${request.method} ${body.method}${body.params?.name ? " " + body.params.name : ""}`);
    else board.event("http", `${s.user} ${request.method}${request.method === "GET" ? " (opens the server→client stream)" : ""}`);
    return s.transport.handleRequest(request, { parsedBody: body, authInfo: auth });
  }

  if (request.method !== "POST") return new Response("missing Mcp-Session-Id", { status: 400 });
  const body = await request.json();
  if (!isInitializeRequest(body)) return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "No session: send initialize first" }, id: null }, { status: 400 });

  // A new client: build its own McpServer + transport. The session id is minted by the server
  // and sent back in the Mcp-Session-Id response header.
  const { server, deployTool } = buildServer();
  const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server, deployTool, user: auth.clientId, client: `${body.params.clientInfo?.name ?? "?"} ${body.params.clientInfo?.version ?? ""}`.trim(), protocol: body.params.protocolVersion, since: Date.now(), streams: 0 });
      board.event("info", `new session ${id.slice(0, 8)} for ${auth.clientId} (${body.params.clientInfo?.name ?? "unknown client"}, proposes ${body.params.protocolVersion})`);
    },
    onsessionclosed: (id) => { sessions.delete(id); board.event("info", `session ${id.slice(0, 8)} closed`); },
  });
  transport.onclose = () => { for (const [id, s] of sessions) if (s.transport === transport) sessions.delete(id); board.draw(); };
  await server.connect(transport);
  board.event("rpc", `${auth.clientId} POST initialize`);
  return transport.handleRequest(request, { parsedBody: body, authInfo: auth });
}

// node:http <-> web-standard Request/Response, so the MCP code above stays runtime-neutral.
async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
  return new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

async function send(res: ServerResponse, r: Response, sid: string | null) {
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (!r.body) { res.end(); return; }
  // sid is only passed for GET: a GET that gets an SSE body is the long-lived server→client stream.
  const live = sid && r.headers.get("content-type")?.includes("text/event-stream") ? sessions.get(sid) : undefined;
  if (live) { live.streams++; board.draw(); }
  const reader = r.body.getReader();
  res.on("close", () => { reader.cancel().catch(() => {}); if (live) { live.streams = Math.max(0, live.streams - 1); board.draw(); } });
  for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
  res.end();
}

const http = createServer(async (req, res) => {
  try {
    const request = await toRequest(req);
    const response = await handle(request);
    await send(res, response, req.method === "GET" ? (req.headers["mcp-session-id"] as string | undefined) ?? null : null);
  } catch (e) {
    board.event("refused", `500 ${(e as Error).message}`);
    if (!res.headersSent) res.writeHead(500).end(String(e)); else res.end();
  }
});

// Sessions live in server memory. A client that exits without DELETE leaves one behind, so close any
// session that has had no open stream for a minute (OpenCode keeps its GET stream open while it runs).
const idleSince = new Map<string, number>();
setInterval(() => {
  for (const [id, s] of sessions) {
    if (s.streams > 0) { idleSince.delete(id); continue; }
    const since = idleSince.get(id) ?? Date.now();
    idleSince.set(id, since);
    if (Date.now() - since > 60_000) { idleSince.delete(id); board.event("info", `session ${id.slice(0, 8)} (${s.user}) idle for 60 s: closed`); void s.transport.close(); }
  }
}, 10_000).unref();

// Bind to 127.0.0.1 only: a local HTTP server on 0.0.0.0 is reachable from your whole network.
http.listen(PORT, "127.0.0.1", () => {
  board.start(() => http.close());
  board.event("info", `listening on http://127.0.0.1:${PORT}/mcp`);
  board.event("refused", "⚠ demo tokens are in plain text in server.ts: alice-dev-token, bob-releaser-token, carol-lead-token");
});
