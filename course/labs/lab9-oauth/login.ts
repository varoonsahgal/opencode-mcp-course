// login.ts: an OAuth client for the terminal, so you can watch every step OpenCode does for you.
//
//   npx tsx login.ts login [--scopes "releases:read releases:deploy"]   do the whole dance, keep the tokens
//   npx tsx login.ts whoami | status | call <tool> [json]               use the tokens (refreshing or stepping up as needed)
//   npx tsx login.ts token                                              print the access token's claims
//   npx tsx login.ts logout                                             forget everything
//   --no-pkce-verify                                                    exchange the code with a wrong verifier (9.F)
//   --as alice|bob|carol                                                be the browser too: sign in as that person without a click
//
// Tokens and the registration live in tokens.local.json next to this file: that is the "on disk"
// Module 6.F warned about, and the reason refresh tokens must rotate (Exercise 9.E).
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider, type OAuthClientMetadata, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { decode } from "./jwt.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 2)[1] ?? dflt) : dflt; };
const flag = (name: string) => { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; };
const DESK = new URL(opt("--url", "http://127.0.0.1:8794/mcp")!);
const SCOPES = opt("--scopes", "releases:read")!;
const BAD_PKCE = flag("--no-pkce-verify");
const AS = opt("--as");
const [cmd = "status", ...rest] = args;
const STORE = new URL("./tokens.local.json", import.meta.url).pathname;
const CALLBACK = "http://127.0.0.1:8796/callback";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c: string) => (s: unknown) => (color ? `\x1b[${c}m${s}\x1b[0m` : String(s));
const [bold, dim, red, green, yellow, cyan] = ["1", "2", "31", "32", "33", "36"].map(paint);
const say = (s: string) => console.log(s);

type Store = { client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens; verifier?: string; state?: string; discovery?: OAuthDiscoveryState };
const load = (): Store => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : {});
const save = (s: Store) => writeFileSync(STORE, JSON.stringify(s, null, 2) + "\n");

// ---------------------------------------------------------------------------------------------
// The provider: everything the SDK's auth flow needs from an application. Each method is one
// thing OpenCode keeps in ~/.local/share/opencode/mcp-auth.json.
// ---------------------------------------------------------------------------------------------
let callbackServer: ReturnType<typeof createServer> | undefined;
const stopWaiting = () => { callbackServer?.close(); callbackServer = undefined; };
const provider: OAuthClientProvider = {
  redirectUrl: CALLBACK,
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "login.ts (course)", redirect_uris: [CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native", scope: SCOPES };
  },
  state: () => { const st = randomUUID(); save({ ...load(), state: st }); return st; }, // compared on the callback: the SDK does not check it
  clientInformation: () => load().client,
  saveClientInformation: (info) => { say(dim(`  registered as ${info.client_id} (dynamic client registration)`)); save({ ...load(), client: info }); },
  tokens: () => load().tokens,
  saveTokens: (tokens) => { const c = decode(tokens.access_token); say(green(`  tokens saved: access for ${c?.sub} [${c?.scope}] aud ${c?.aud}, expires in ${(c?.exp ?? 0) - Math.floor(Date.now() / 1000)}s${tokens.refresh_token ? ", plus a refresh token" : ""}`)); save({ ...load(), tokens }); },
  redirectToAuthorization: (url) => {
    say(dim(`  asking for scope "${url.searchParams.get("scope")}" for resource ${url.searchParams.get("resource")}`));
    if (AS) { say(dim(`  --as ${AS}: playing the browser, signing in as ${AS}`)); setTimeout(() => { void fetch(`${url}&as=${AS}`, { redirect: "follow" }).catch(() => {}); }, 200); return; }
    say(bold(`\n  Open this in your browser and sign in:\n  ${url}\n`));
    say(dim("  (waiting for the authorization server to send the code to " + CALLBACK + ")"));
  },
  saveDiscoveryState: (d) => save({ ...load(), discovery: d }),
  discoveryState: () => load().discovery,
  saveCodeVerifier: (v) => save({ ...load(), verifier: v }),
  codeVerifier: () => { const v = load().verifier; if (!v) throw new Error("no code verifier saved"); return BAD_PKCE ? v.split("").reverse().join("") : v; },
  invalidateCredentials: (scope) => { say(yellow(`  invalidating ${scope}`)); const s = load(); if (scope === "all" || scope === "tokens") delete s.tokens; if (scope === "all" || scope === "client") delete s.client; if (scope === "all" || scope === "verifier") delete s.verifier; if (scope === "all" || scope === "discovery") delete s.discovery; save(s); },
};

// A tiny callback server: the browser lands here with ?code=…&state=…&iss=…
function waitForCode(): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { srv.close(); reject(new Error("nobody signed in within two minutes")); }, 120_000); timer.unref();
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? "/", CALLBACK);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (u.searchParams.get("error")) { res.end(`<p>Denied: ${u.searchParams.get("error_description")}</p>`); clearTimeout(timer); srv.close(); reject(new Error(`authorization denied: ${u.searchParams.get("error_description")}`)); return; }
      res.end("<p style=\"font:17px system-ui;margin:60px auto;max-width:400px\">✅ Signed in. You can close this tab and go back to your terminal.</p>");
      say(dim(`  callback received: code ${u.searchParams.get("code")?.slice(0, 14)}… state ${u.searchParams.get("state")?.slice(0, 8)}… iss ${u.searchParams.get("iss")}`));
      clearTimeout(timer); srv.close();
      if (u.searchParams.get("state") !== load().state) { reject(new Error("state mismatch: this callback is not the answer to our request")); return; }
      resolve(u.searchParams);
    });
    srv.listen(8796, "127.0.0.1"); callbackServer = srv;
  });
}

// Run one operation against the desk. If the desk says 401 (no or expired token that cannot be
// refreshed) or 403 insufficient_scope (step-up), the SDK has already started the authorization flow
// by the time we see UnauthorizedError: wait for the code, finish, reconnect, and try once more.
async function withDesk<T>(op: (client: Client) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const transport = new StreamableHTTPClientTransport(DESK, { authProvider: provider });
    const client = new Client({ name: "login.ts", version: "1.0.0" });
    const codeWait = waitForCode(); codeWait.catch(() => {});
    try {
      await client.connect(transport);
      const out = await op(client);
      stopWaiting(); await client.close();
      return out;
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) { stopWaiting(); await client.close().catch(() => {}); throw e; }
      if (attempt > 1) {
        stopWaiting(); await client.close().catch(() => {});
        const have = decode(load().tokens?.access_token ?? "")?.scope ?? "nothing";
        throw new Error(`still refused after signing in again. The authorization server granted [${have}]: whoever signed in is not entitled to what this tool needs, and no client can change that.`);
      }
      say(yellow(attempt === 1 && !load().tokens ? "  401 from the desk → discovered the authorization server, registered, asked you to sign in" : "  the desk wants more (401 expired / 403 insufficient_scope) → back to the authorization server"));
      const params = await codeWait;
      await transport.finishAuth(params); // the SDK checks iss (RFC 9207), then redeems code + PKCE verifier
      await client.close().catch(() => {});
    }
  }
}
const firstText = (r: { content: unknown }) => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join(" ");

try {
  switch (cmd) {
    case "logout": if (existsSync(STORE)) unlinkSync(STORE); say("forgotten: tokens and registration deleted"); break;
    case "token": { const t = load().tokens; if (!t) { say("no tokens; run login first"); break; } const c = decode(t.access_token); say(JSON.stringify(c, null, 2)); say(dim(`expires in ${(c?.exp ?? 0) - Math.floor(Date.now() / 1000)}s · refresh token ${t.refresh_token ? "present" : "absent"}`)); break; }
    case "login": { const t = await withDesk((c) => c.callTool({ name: "whoami", arguments: {} })); say(`\n${green("signed in")}: ${firstText(t)}`); break; }
    case "status": case "whoami": { const t = await withDesk((c) => c.callTool({ name: "whoami", arguments: {} })); say(`${green("desk says")}: ${firstText(t)}`); break; }
    case "call": {
      const name = rest[0]; const a = rest[1] ? JSON.parse(rest[1]) : {};
      const r = await withDesk((c) => c.callTool({ name, arguments: a }, { timeout: 120_000, onprogress: (p) => say(dim(`  progress ${p.progress}/${p.total ?? "?"} ${p.message ?? ""}`)) }));
      say(`${r.isError ? red("tool error") : green("result")}: ${firstText(r)}`);
      break;
    }
    default: say("commands: login · whoami · call <tool> [json] · token · logout");
  }
} catch (e) {
  say(red(`${(e as Error).name}: ${(e as Error).message}`));
  process.exitCode = 1;
}
