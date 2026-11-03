// Lab 9 · The release desk as an OAuth resource server.
//
//   npx tsx desk.ts                 -> http://127.0.0.1:8794/mcp (plain log; the board is the auth server's)
//
// Same tools as Modules 6 and 8, but the bearer token is no longer a string from a table: it is a JWT
// minted by auth-server.ts for a person who signed in. The desk's job is to VERIFY, not to issue:
// signature, issuer, audience, expiry, scopes. It also publishes where its authorization server is,
// so a client that has never heard of it can find the login page from a single 401.
//   TODO 1  check who issued the token, who it is for (audience) and whether it has expired
//   TODO 2  challenge for more scope per tool (403 insufficient_scope), so clients can step up
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  McpServer, createMcpHandler, requireBearerAuth, requireScopes, OAuthError, OAuthErrorCode, oauthMetadataResponse, getOAuthProtectedResourceMetadataUrl, // requireScopes: TODO 2
  hostHeaderValidationResponse, originValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins,
  type AuthInfo, type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { verifySignature, decode } from "./jwt.ts";

const PORT = Number(process.env.PORT ?? 8794);
const DESK_URL = `http://127.0.0.1:${PORT}/mcp`;
const ISSUER = process.env.AS_URL ?? "http://127.0.0.1:8791";
const SECRET = process.env.DESK_JWT_SECRET ?? "lab-only-shared-secret-change-me-32bytes!!";
const SERVICES = ["web", "api", "payments"] as const;
const PREFLIGHT_STEPS = ["unit tests", "integration tests", "migration dry-run", "canary health", "error budget"];
const STEP_MS = Number(process.env.STEP_MS ?? 600);

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c: string) => (s: unknown) => (color ? `\x1b[${c}m${s}\x1b[0m` : String(s));
const [bold, dim, red, green, yellow, cyan] = ["1", "2", "31", "32", "33", "36"].map(paint);
const log = (kind: "http" | "auth" | "call" | "ok" | "refused" | "write" | "info", text: string) => console.log(`${dim(new Date().toTimeString().slice(0, 8))} ${({ http: dim, auth: red, call: bold, ok: green, refused: red, write: yellow, info: cyan })[kind](text)}`);

// ---------------------------------------------------------------------------------------------
// Authentication: a JWT verifier. requireBearerAuth turns a thrown OAuthError into a 401 with a
// WWW-Authenticate header that names this server's protected-resource metadata, which is how a
// client discovers the authorization server.
// ---------------------------------------------------------------------------------------------
const verifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let claims;
    try { claims = verifySignature(token, SECRET); } catch (e) { throw new OAuthError(OAuthErrorCode.InvalidToken, `not a token this desk trusts (${(e as Error).message})`); }
    // TODO 1 · A valid signature only proves the authorization server minted it. Check that it was
    //          minted BY the server you trust (claims.iss === ISSUER), FOR this desk (pass
    //          resource: new URL(claims.aud) and set expectedResource below), and that it is still
    //          valid (claims.exp, and use it as expiresAt instead of the hour copied from Module 6).
    //          Until then any token from the AS is accepted: one minted for another resource, or last week.
    return { token, clientId: claims.sub, scopes: claims.scope.split(" "), expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { jti: claims.jti, via: claims.client_id } };
  },
};
const authGate = requireBearerAuth({
  verifier,
  requiredScopes: ["releases:read"],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(DESK_URL)),
  // TODO 1 · audience: expectedResource: new URL(DESK_URL), so a token for another resource is refused
});
// Protected Resource Metadata (RFC 9728): "my authorization server is over there".
const metadata = {
  resourceServerUrl: new URL(DESK_URL),
  scopesSupported: ["releases:read", "releases:deploy", "releases:freeze"],
  // The SDK also serves /.well-known/oauth-authorization-server on this origin for legacy clients that probe here first.
  oauthMetadata: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, registration_endpoint: `${ISSUER}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"] },
};

// ---------------------------------------------------------------------------------------------
// The desk itself. Per-request instances (2026 style), both eras served.
// ---------------------------------------------------------------------------------------------
const desk = {
  services: { web: { version: "4.11.0", deployed_by: "carol", at: "09:12" }, api: { version: "2.30.1", deployed_by: "bob", at: "10:40" }, payments: { version: "7.2.4", deployed_by: "carol", at: "yesterday" } } as Record<string, { version: string; deployed_by: string; at: string }>,
  freeze: null as null | { by: string; reason: string },
  preflights: [] as { user: string; service: string; version: string; passed: boolean }[],
};
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const refuse = (t: string) => ({ isError: true, content: [{ type: "text" as const, text: t }] });
const who = (ctx: ServerContext) => ctx.http?.authInfo?.clientId ?? "unknown";
const can = (ctx: ServerContext, scope: string) => ctx.http?.authInfo?.scopes.includes(scope) ?? false;

function buildServer(): McpServer {
  const server = new McpServer({ name: "release-desk", version: "3.0.0" }, { instructions: "Shared release desk. Deploys need a passing preflight for the same version." });

  server.registerTool("whoami", {
    title: "Who am I?", description: "Show who this request is authenticated as (from the OAuth token), which client obtained the token, its scopes and when it expires.",
    inputSchema: z.object({}), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (_a, ctx) => {
    const a = ctx.http?.authInfo; const left = (a?.expiresAt ?? 0) - Math.floor(Date.now() / 1000);
    return text(`You are ${a?.clientId} (scopes: ${a?.scopes.join(", ")}), via client ${(a?.extra as { via?: string })?.via ?? "?"}. Token ${(a?.extra as { jti?: string })?.jti?.slice(0, 8)} expires in ${left}s.`);
  });
  server.registerTool("release_status", {
    title: "Release status", description: "Current version of every service and whether a freeze is active.", inputSchema: z.object({}), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => text([...Object.entries(desk.services).map(([id, s]) => `${id}: ${s.version} (deployed by ${s.deployed_by} at ${s.at})`), desk.freeze ? `FREEZE by ${desk.freeze.by}: ${desk.freeze.reason}` : "No freeze."].join("\n")));
  server.registerTool("run_preflight", {
    title: "Run preflight checks", description: "Run the preflight checks for deploying a version of a service (a few seconds). Required before deploy.",
    inputSchema: z.object({ service: z.enum(SERVICES), version: z.string().regex(/^\d+\.\d+\.\d+$/) }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ service, version }, ctx) => {
    log("call", `${who(ctx)} → run_preflight ${service}@${version}`);
    for (const [i, label] of PREFLIGHT_STEPS.entries()) {
      if (ctx.mcpReq.signal.aborted) return refuse("Preflight cancelled.");
      const token = ctx.mcpReq._meta?.progressToken;
      if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: i, total: PREFLIGHT_STEPS.length, message: label } });
      await sleep(STEP_MS, ctx.mcpReq.signal);
    }
    desk.preflights.push({ user: who(ctx), service, version, passed: true });
    log("ok", `${who(ctx)} preflight ${service}@${version} passed`);
    return text(`Preflight for ${service}@${version}: all ${PREFLIGHT_STEPS.length} checks passed. Ready to deploy.`);
  });
  server.registerTool("deploy", {
    title: "Deploy a version", description: "Deploy a version of a service to production. Needs the releases:deploy scope and a passing preflight for the same version. Only when the user explicitly asks.",
    inputSchema: z.object({ service: z.enum(SERVICES), version: z.string().regex(/^\d+\.\d+\.\d+$/) }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    // TODO 2 · Step-up. Without this, a token that lacks releases:deploy reaches the handler and gets a
    //          polite isError the MODEL can read. With scopeChallenge: requireScopes("releases:deploy"),
    //          the SDK answers 403 insufficient_scope with a WWW-Authenticate challenge the CLIENT's
    //          OAuth code can act on: go back to the authorization server and ask for the missing scope.
    //          Keep the handler check as well. Same for the two freeze tools (releases:freeze).
  }, async ({ service, version }, ctx) => {
    const user = who(ctx);
    if (!can(ctx, "releases:deploy")) { log("refused", `REFUSED ${user}: token lacks releases:deploy`); return refuse(`${user} cannot deploy: the token lacks releases:deploy.`); }
    if (desk.freeze) return refuse(`Deploys are frozen by ${desk.freeze.by}: ${desk.freeze.reason}`);
    if (!desk.preflights.some((p) => p.service === service && p.version === version && p.passed)) return refuse(`No passing preflight for ${service}@${version}. Run run_preflight first.`);
    const before = desk.services[service].version;
    desk.services[service] = { version, deployed_by: user, at: new Date().toTimeString().slice(0, 5) };
    log("write", `✎ DEPLOY ${service} ${before} → ${version} by ${user}`);
    return text(`Deployed ${service} ${before} → ${version} as ${user}.`);
  });
  server.registerTool("declare_freeze", {
    title: "Declare a deploy freeze", description: "Stop all deploys until lifted. Needs releases:freeze.", inputSchema: z.object({ reason: z.string().min(3).max(200) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // TODO 2 · scopeChallenge: requireScopes("releases:freeze"),
  }, async ({ reason }, ctx) => {
    if (!can(ctx, "releases:freeze")) return refuse(`${who(ctx)} cannot declare a freeze: the token lacks releases:freeze.`);
    desk.freeze = { by: who(ctx), reason }; log("write", `❄ FREEZE by ${who(ctx)}: ${reason}`); return text(`Freeze declared by ${who(ctx)}.`);
  });
  server.registerTool("lift_freeze", {
    title: "Lift the deploy freeze", description: "Lift an active freeze. Needs releases:freeze.", inputSchema: z.object({}), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // TODO 2 · scopeChallenge: requireScopes("releases:freeze"),
  }, async (_a, ctx) => {
    if (!can(ctx, "releases:freeze")) return refuse(`${who(ctx)} cannot lift the freeze: the token lacks releases:freeze.`);
    desk.freeze = null; log("write", `☀ freeze lifted by ${who(ctx)}`); return text("Freeze lifted.");
  });
  return server;
}
const mcp = createMcpHandler(buildServer, { legacy: "stateless", onerror: (e) => log("refused", `handler: ${e.message}`) });

// ---------------------------------------------------------------------------------------------
// HTTP: metadata is public; everything else needs a token.
// ---------------------------------------------------------------------------------------------
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const md = oauthMetadataResponse(request, metadata);
  if (md) { log("http", `${request.method} ${url.pathname} → protected resource metadata (public)`); return md; }
  if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
  const rejected = hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins());
  if (rejected) return rejected;
  const auth = await authGate(request);
  if (auth instanceof Response) {
    const claims = decode((request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    log("auth", `${auth.status} ${request.method} ${claims ? `token for ${claims.sub} (aud ${claims.aud}, iss ${claims.iss}, exp ${claims.exp - Math.floor(Date.now() / 1000)}s)` : "no token"}: ${auth.headers.get("www-authenticate")}`);
    return auth;
  }
  const h = (n: string) => request.headers.get(n);
  let bodyMethod = ""; if (request.method === "POST") { try { bodyMethod = (await request.clone().json())?.method ?? ""; } catch { /* */ } }
  log("http", `${auth.clientId} ${request.method} ${h("mcp-method") ?? bodyMethod}${h("mcp-name") ? " " + h("mcp-name") : ""} ${dim(`scopes [${auth.scopes.join(" ")}] · expires in ${(auth.expiresAt ?? 0) - Math.floor(Date.now() / 1000)}s`)}`);
  const response = await mcp.fetch(request, { authInfo: auth });
  if (response.status === 403) log("auth", `403 for ${auth.clientId}: ${response.headers.get("www-authenticate")}`);
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
  const reader = r.body.getReader(); res.on("close", () => { reader.cancel().catch(() => {}); });
  for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); } res.end();
}
createServer(async (req, res) => { try { await send(res, await handle(await toRequest(req))); } catch (e) { log("refused", `500 ${(e as Error).message}`); if (!res.headersSent) res.writeHead(500).end(String(e)); else res.end(); } })
  .listen(PORT, "127.0.0.1", () => { log("info", `release desk (resource server) on ${DESK_URL} · trusts tokens from ${ISSUER} · metadata at ${getOAuthProtectedResourceMetadataUrl(new URL(DESK_URL))}`); void randomUUID; });
