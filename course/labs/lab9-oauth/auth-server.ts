// Lab 9 · A toy OAuth 2.1 authorization server for the release desk.
//
//   npx tsx auth-server.ts            -> http://127.0.0.1:8791, with a board in this terminal
//   npx tsx auth-server.ts --plain    -> one log line per event
//   TOKEN_TTL=90                      -> access-token lifetime in seconds (default 90, so you can watch one expire)
//
// It does the four things an authorization server does for MCP: publishes its metadata, registers
// clients (RFC 7591 dynamic registration), shows a person a login page and sends a one-time code
// back to the client (authorization code + PKCE), and exchanges codes and refresh tokens for access
// tokens (JWTs with an audience). Everything is in memory and nothing here is production grade:
// the point is to see every step, not to deploy it. The TODOs are the checks it skips at first:
//   TODO 3  rotate refresh tokens, and detect a refresh token being used twice
//   TODO 4  verify PKCE (code_verifier must hash to the code_challenge) and make codes one-shot
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sign } from "./jwt.ts";
import * as board from "./board.ts";

const PORT = Number(process.env.AS_PORT ?? 8791);
const ISSUER = `http://127.0.0.1:${PORT}`;
const DESK_URL = process.env.DESK_URL ?? "http://127.0.0.1:8794/mcp"; // the resource this server mints tokens for
const TOKEN_TTL = Number(process.env.TOKEN_TTL ?? 90);
const SECRET = process.env.DESK_JWT_SECRET ?? "lab-only-shared-secret-change-me-32bytes!!"; // HS256 for the lab; production: asymmetric keys + JWKS
const SCOPES = ["releases:read", "releases:deploy", "releases:freeze"];

// Who exists, and what each person may be granted. Entitlements live HERE, with the identity
// provider, not in the MCP server and not in any client config.
const PEOPLE: Record<string, { name: string; scopes: string[] }> = {
  alice: { name: "Alice · developer", scopes: ["releases:read"] },
  bob:   { name: "Bob · releaser",    scopes: ["releases:read", "releases:deploy"] },
  carol: { name: "Carol · lead",      scopes: ["releases:read", "releases:deploy", "releases:freeze"] },
};

type Client = board.ClientRow & { token_endpoint_auth_method: string };
const clients = new Map<string, Client>();
// A pre-registered client, the way most production setups start: nobody registers over HTTP.
clients.set("desk-cli", { client_id: "desk-cli", client_name: "pre-registered CLI", redirect_uris: ["http://127.0.0.1:8796/callback"], how: "pre-registered", at: Date.now(), token_endpoint_auth_method: "none" });

type Code = { client_id: string; redirect_uri: string; code_challenge: string; scope: string[]; resource: string; user: string; exp: number; used: boolean };
const codes = new Map<string, Code>();
type Refresh = { family: string; client_id: string; user: string; scope: string[]; resource: string; used: boolean };
const refreshTokens = new Map<string, Refresh>();
const revokedFamilies = new Set<string>();
const tokens: board.TokenRow[] = [];
const stats: board.Stats = { codes: 0, tokens: 0, refreshes: 0, denied: 0, reuse: 0 };
board.attach(() => ({ clients: [...clients.values()], tokens, stats }));

const now = () => Math.floor(Date.now() / 1000);
const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra }); res.end(JSON.stringify(body, null, 2)); };
const html = (res: ServerResponse, status: number, body: string) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }); res.end(`<!doctype html><meta charset="utf-8"><title>Release desk · sign in</title><body style="font:17px/1.5 system-ui;max-width:560px;margin:50px auto;padding:0 20px;color:#231433">${body}</body>`); };
const deny = (res: ServerResponse, status: number, error: string, description: string) => { stats.denied++; board.event("denied", `${status} ${error}: ${description}`); json(res, status, { error, error_description: description }); };
const readBody = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); return Buffer.concat(chunks).toString("utf8"); };

function mint(user: string, scope: string[], resource: string, client_id: string, family: string, refreshed = 0) {
  const jti = randomUUID();
  const exp = now() + TOKEN_TTL;
  const access = sign({ iss: ISSUER, sub: user, aud: resource, scope: scope.join(" "), exp, iat: now(), jti, client_id }, SECRET);
  const refresh = "rt_" + randomBytes(24).toString("base64url");
  refreshTokens.set(refresh, { family, client_id, user, scope, resource, used: false });
  tokens.push({ jti, user, scope: scope.join(" "), aud: resource, client_id, exp, refreshed });
  stats.tokens++;
  board.event("token", `access token for ${user} (${scope.join(" ")}) aud ${resource} · expires in ${TOKEN_TTL}s · jti ${jti.slice(0, 8)} · refresh ${refresh.slice(0, 10)}…`);
  return { access_token: access, token_type: "Bearer", expires_in: TOKEN_TTL, scope: scope.join(" "), refresh_token: refresh };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", ISSUER);
  board.event("http", `${req.method} ${url.pathname}${url.search ? " ?" + [...url.searchParams.keys()].join(",") : ""}`);

  // 1. Metadata (RFC 8414): where everything is, and what this server supports.
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(res, 200, {
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, registration_endpoint: `${ISSUER}/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"], scopes_supported: SCOPES, authorization_response_iss_parameter_supported: true,
    });
  }

  // 2. Dynamic client registration (RFC 7591). Deprecated in the 2026 revision in favour of client ID
  //    metadata documents, still what OpenCode 1.x and most clients send today.
  if (url.pathname === "/register" && req.method === "POST") {
    const m = JSON.parse(await readBody(req) || "{}") as { client_name?: string; redirect_uris?: string[]; token_endpoint_auth_method?: string; application_type?: string };
    if (!Array.isArray(m.redirect_uris) || !m.redirect_uris.length) return deny(res, 400, "invalid_redirect_uri", "redirect_uris is required");
    if (!m.redirect_uris.every((u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u))) return deny(res, 400, "invalid_redirect_uri", "this lab only sends codes to loopback redirect URIs");
    const client_id = "dyn_" + randomBytes(6).toString("hex");
    const c: Client = { client_id, client_name: m.client_name ?? "unnamed client", redirect_uris: m.redirect_uris, how: "dynamic", at: Date.now(), token_endpoint_auth_method: m.token_endpoint_auth_method ?? "none" };
    clients.set(client_id, c);
    board.event("register", `registered ${client_id} "${c.client_name}" → ${c.redirect_uris.join(" ")} (${m.application_type ?? "no application_type"})`);
    return json(res, 201, { client_id, client_name: c.client_name, redirect_uris: c.redirect_uris, token_endpoint_auth_method: c.token_endpoint_auth_method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  }

  // 3. The login page: the only place a person is involved, and the only place entitlements are applied.
  if (url.pathname === "/authorize") {
    const q = Object.fromEntries(url.searchParams) as Record<string, string>;
    const c = clients.get(q.client_id ?? "");
    if (!c) return html(res, 400, `<h1>Unknown client</h1><p><code>${q.client_id ?? "(none)"}</code> is not registered. The client must register first (or be pre-registered).</p>`);
    if (!c.redirect_uris.includes(q.redirect_uri ?? "")) return html(res, 400, `<h1>Redirect URI mismatch</h1><p><code>${q.redirect_uri}</code> is not one this client registered. A code is only ever sent to a registered address, so a stolen client_id cannot redirect codes elsewhere.</p>`);
    if (q.response_type !== "code" || !q.code_challenge || q.code_challenge_method !== "S256") return html(res, 400, `<h1>Bad request</h1><p>response_type=code with a S256 code_challenge is required (PKCE is mandatory in OAuth 2.1).</p>`);
    const wanted = (q.scope ?? "releases:read").split(/[ +]/).filter(Boolean);
    const resource = q.resource ?? DESK_URL;
    const chosen = q.as ?? (req.method === "POST" ? new URLSearchParams(await readBody(req)).get("as") ?? undefined : undefined);
    if (!chosen) {
      board.event("login", `login page shown to ${c.client_name}: wants [${wanted.join(" ")}] for ${resource}`);
      const rows = Object.entries(PEOPLE).map(([id, p]) => { const granted = wanted.filter((s) => p.scopes.includes(s)); const missing = wanted.filter((s) => !p.scopes.includes(s)); return `<form method="post" style="margin:10px 0"><input type="hidden" name="as" value="${id}"><button style="font:inherit;padding:10px 16px;border-radius:10px;border:0;background:#4f46e5;color:#fff;min-width:200px">Sign in as ${p.name}</button> <span style="color:#5d4e6e;font-size:14px">gets: ${granted.join(", ") || "nothing"}${missing.length ? ` · <span style="color:#b91c1c">not entitled to ${missing.join(", ")}</span>` : ""}</span></form>`; }).join("");
      return html(res, 200, `<h1>Sign in to the release desk</h1><p><b>${c.client_name}</b> <span style="color:#5d4e6e">(${c.client_id})</span> is asking for access to <code>${resource}</code> with scopes <code>${wanted.join(" ")}</code>.</p>${rows}<form method="post"><input type="hidden" name="as" value="deny"><button style="font:inherit;padding:10px 16px;border-radius:10px;border:1px solid #e11d48;background:#fff;color:#e11d48">Deny</button></form><p style="color:#9a8aa8;font-size:13px">Lab shortcut for scripts: add <code>&amp;as=alice</code> to this URL.</p>`);
    }
    const redirect = new URL(q.redirect_uri);
    if (chosen === "deny" || !PEOPLE[chosen]) {
      redirect.searchParams.set("error", "access_denied"); redirect.searchParams.set("error_description", "the person declined"); if (q.state) redirect.searchParams.set("state", q.state);
      board.event("denied", `${c.client_name}: the person declined`); stats.denied++;
      res.writeHead(302, { location: redirect.toString() }); return res.end();
    }
    const granted = wanted.filter((s) => PEOPLE[chosen].scopes.includes(s));
    if (!granted.length) { redirect.searchParams.set("error", "access_denied"); redirect.searchParams.set("error_description", `${chosen} is entitled to none of: ${wanted.join(" ")}`); if (q.state) redirect.searchParams.set("state", q.state); board.event("denied", `${chosen} asked for [${wanted.join(" ")}] and is entitled to none of it`); stats.denied++; res.writeHead(302, { location: redirect.toString() }); return res.end(); }
    const code = "code_" + randomBytes(16).toString("base64url");
    codes.set(code, { client_id: c.client_id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, scope: granted, resource, user: chosen, exp: now() + 120, used: false });
    stats.codes++;
    board.event("code", `${chosen} signed in for ${c.client_name}: code ${code.slice(0, 14)}… for [${granted.join(" ")}]${granted.length < wanted.length ? ` (asked for ${wanted.length}, entitled to ${granted.length})` : ""}`);
    redirect.searchParams.set("code", code); if (q.state) redirect.searchParams.set("state", q.state); redirect.searchParams.set("iss", ISSUER); // RFC 9207: the client checks who sent it back
    res.writeHead(302, { location: redirect.toString() }); return res.end();
  }

  // 4. The token endpoint: codes and refresh tokens in, access tokens out.
  if (url.pathname === "/token" && req.method === "POST") {
    const f = Object.fromEntries(new URLSearchParams(await readBody(req))) as Record<string, string>;
    const c = clients.get(f.client_id ?? "");
    if (!c) return deny(res, 401, "invalid_client", `unknown client_id ${f.client_id}`);
    if (f.grant_type === "authorization_code") {
      const code = codes.get(f.code ?? "");
      if (!code) return deny(res, 400, "invalid_grant", "unknown code");
      if (code.exp < now()) { codes.delete(f.code); return deny(res, 400, "invalid_grant", "code expired (codes live two minutes)"); }
      if (code.client_id !== c.client_id) return deny(res, 400, "invalid_grant", "code was issued to another client");
      if (code.redirect_uri !== f.redirect_uri) return deny(res, 400, "invalid_grant", "redirect_uri does not match the one the code was issued for");
      if (f.resource && f.resource !== code.resource) return deny(res, 400, "invalid_target", `the code was issued for ${code.resource}, not ${f.resource}`);
      // TODO 4 · PKCE. The code travelled through a browser redirect, where it can be stolen. The
      //          verifier never did. Refuse unless base64url(sha256(code_verifier)) === code_challenge,
      //          and mark the code used so a second exchange fails even with the right verifier.
      void createHash; // TODO 4: base64url(sha256(f.code_verifier)) must equal code.code_challenge; code.used must be false (then set it)
      return json(res, 200, mint(code.user, code.scope, code.resource, c.client_id, randomUUID()));
    }
    if (f.grant_type === "refresh_token") {
      const r = refreshTokens.get(f.refresh_token ?? "");
      if (!r || r.client_id !== c.client_id) return deny(res, 400, "invalid_grant", "unknown refresh token");
      if (revokedFamilies.has(r.family)) return deny(res, 400, "invalid_grant", "this refresh token's family was revoked");
      // TODO 3 · Rotation. A refresh token is long-lived and sits on disk. Issue a NEW refresh token on
      //          every use and burn the old one; if a burned one comes back, somebody copied it: revoke
      //          the whole family (every token descended from the same login).
      //          (until then a refresh token works forever, however many copies of it exist)
      stats.refreshes++;
      const scope = f.scope ? f.scope.split(" ").filter((s) => r.scope.includes(s)) : r.scope;
      board.event("refresh", `${r.user} refreshed via ${c.client_name}: new access token${r.used ? ", old refresh token burned" : " (the refresh token still works)"}`);
      const prev = tokens.filter((t) => t.user === r.user && t.client_id === c.client_id).length;
      return json(res, 200, mint(r.user, scope, r.resource, c.client_id, r.family, prev));
    }
    return deny(res, 400, "unsupported_grant_type", `grant_type ${f.grant_type}`);
  }

  if (url.pathname === "/") return html(res, 200, `<h1>Release desk authorization server</h1><p>Metadata: <a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a>. Nothing to see here without a client that sends you to <code>/authorize</code>.</p>`);
  res.writeHead(404).end("not found");
}

createServer((req, res) => { handle(req, res).catch((e) => { board.event("denied", `500 ${(e as Error).message}`); if (!res.headersSent) res.writeHead(500).end(String(e)); }); })
  .listen(PORT, "127.0.0.1", () => { board.start(() => process.exit(0)); board.event("info", `issuer ${ISSUER} · minting tokens for ${DESK_URL} · access tokens live ${TOKEN_TTL}s · people: alice (read), bob (read, deploy), carol (read, deploy, freeze)`); });
