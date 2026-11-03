// wire.ts: a client that shows you the wire. Every HTTP exchange is printed as it happens.
//
//   npx tsx wire.ts [--era legacy|auto|2026] [--token bob-releaser-token] [--tamper] <command> [args]
//
//   handshake                   connect and print what was negotiated (and how many requests it took)
//   tools                       list tools (twice, to see the client-side cache at work)
//   call <tool> [json]          call a tool; answer any question it asks you
//   --tamper [--tamper-to V]    on the retry, change arguments.version to V (default 9.9.9): what a confused model, or a proxy, could do
//   --tamper-state              on the retry, also flip the last characters of the echoed requestState
//   listen [seconds]            open a subscriptions/listen stream and print what arrives (2026 only)
//   read desk://status          read a resource
//
// --era legacy  = the 2025 handshake OpenCode 1.x uses (initialize, then requests)
// --era auto    = probe with server/discover and use 2026-07-28 if the server speaks it (default)
// --era 2026    = require 2026-07-28, fail loudly otherwise
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client, StreamableHTTPClientTransport, type ElicitRequestParams, type ElicitResult } from "@modelcontextprotocol/client";

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 2)[1] ?? dflt) : dflt; };
const flag = (name: string) => { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; };
const ERA = opt("--era", "auto")!, TOKEN = opt("--token", process.env.DESK_TOKEN ?? "bob-releaser-token")!, URL_ = opt("--url", "http://127.0.0.1:8792/mcp")!;
const TAMPER_TO = opt("--tamper-to", "9.9.9")!, TAMPER_STATE = flag("--tamper-state"), TAMPER = flag("--tamper") || TAMPER_STATE, QUIET = flag("--quiet");
const [cmd = "handshake", ...rest] = args;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c: string) => (s: unknown) => (color ? `\x1b[${c}m${s}\x1b[0m` : String(s));
const [bold, dim, red, green, yellow, cyan, magenta] = ["1", "2", "31", "32", "33", "36", "35"].map(paint);
const say = (s: string) => console.log(s);
const preview = (s: string, n = 150) => s.replace(/\s+/g, " ").slice(0, n) + (s.length > n ? "…" : "");

// ---------------------------------------------------------------------------------------------
// The wiretap: a fetch that prints what goes out and what comes back, and (with --tamper) edits the
// multi-round-trip retry on its way out, exactly where an attacker between client and server would.
// ---------------------------------------------------------------------------------------------
let exchanges = 0;
const tappedFetch: typeof fetch = async (url, init) => {
  exchanges++;
  const method = init?.method ?? "GET";
  const hdr = new Headers(init?.headers);
  let body = typeof init?.body === "string" ? init.body : "";
  if (TAMPER && body.includes('"inputResponses"')) {
    const j = JSON.parse(body);
    const confirmed = j.params.arguments.version; j.params.arguments.version = TAMPER_TO;
    say(red(`  ✂ tampered the retry: arguments.version → ${TAMPER_TO} (the person confirmed ${confirmed})`));
    if (TAMPER_STATE && typeof j.params.requestState === "string") {
      const state: string = j.params.requestState;
      j.params.requestState = state.slice(0, -2) + (state.endsWith("A") ? "BB" : "AA");
      say(red("  ✂ tampered the requestState too: flipped its last two characters"));
    }
    body = JSON.stringify(j); init = { ...init, body };
  }
  if (!QUIET) {
    const mirrored = [...hdr.entries()].filter(([k]) => k.startsWith("mcp")).map(([k, v]) => `${k}: ${v}`).join(" · ");
    say(cyan(`→ ${method} ${new URL(String(url)).pathname}`) + (mirrored ? dim(`  ${mirrored}`) : "") + (hdr.get("authorization") ? dim("  authorization: Bearer …") : ""));
    if (body) say(dim(`  ${preview(body)}`));
  }
  const res = await fetch(url, init);
  const ct = res.headers.get("content-type") ?? "";
  if (QUIET) return res;
  if (ct.includes("text/event-stream")) {
    say(magenta(`← ${res.status} text/event-stream`) + dim("  (events as they arrive)"));
    const dec = new TextDecoder();
    const body2 = res.body!.pipeThrough(new TransformStream({ transform(chunk, ctl) { for (const line of dec.decode(chunk, { stream: true }).split("\n")) if (line.startsWith("data:")) say(dim(`  ${preview(line.slice(5).trim())}`)); ctl.enqueue(chunk); } }));
    return new Response(body2, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  const txt = await res.clone().text();
  let note = "";
  try { const j = JSON.parse(txt); if (j.error) note = red(` error ${j.error.code}: ${j.error.message}`); else if (j.result) note = (j.result.resultType ? bold(` resultType=${j.result.resultType}`) : "") + (j.result.ttlMs !== undefined ? yellow(` ttlMs=${j.result.ttlMs} cacheScope=${j.result.cacheScope}`) : ""); } catch { /* not JSON */ }
  say((res.ok ? green : red)(`← ${res.status}`) + dim(` ${ct.split(";")[0] || "(no body)"}`) + note);
  if (txt) say(dim(`  ${preview(txt)}`));
  return res;
};

// ---------------------------------------------------------------------------------------------
// The client. Same Client class as host.ts; the only new thing is versionNegotiation.
// ---------------------------------------------------------------------------------------------
const rl = createInterface({ input, output, terminal: !!input.isTTY });
async function elicit(p: ElicitRequestParams): Promise<ElicitResult> {
  say(magenta(`\n  the desk asks: ${p.message}`));
  if (p.mode === "url") { say(`  open ${p.url}`); const a = await rl.question("  opened? [Enter = yes, n = decline] "); return { action: a.trim() === "n" ? "decline" : "accept" }; }
  const content: Record<string, string | number | boolean> = {};
  for (const [key, def] of Object.entries((p.requestedSchema.properties ?? {}) as Record<string, { type?: string; title?: string; description?: string }>)) {
    const raw = (await rl.question(`  ${def.description ?? def.title ?? key}${def.type === "boolean" ? " (y/n)" : ""}: `)).trim();
    if (raw === "/decline") return { action: "decline" };
    if (raw === "") continue;
    content[key] = def.type === "boolean" ? /^(y|yes|true)$/i.test(raw) : def.type === "number" || def.type === "integer" ? Number(raw) : raw;
  }
  return { action: "accept", content };
}

const client = new Client({ name: "wire", version: "1.0.0" }, {
  capabilities: { elicitation: { form: {}, url: {} } },
  versionNegotiation: ERA === "legacy" ? undefined : ERA === "2026" ? { mode: { pin: "2026-07-28" } } : { mode: "auto" },
});
client.setRequestHandler("elicitation/create", async (req) => elicit(req.params));
client.setNotificationHandler("notifications/tools/list_changed", async (n) => say(magenta(`  ⟵ notifications/tools/list_changed ${dim(JSON.stringify(n.params?._meta ?? {}))}`)));
client.setNotificationHandler("notifications/resources/updated", async (n) => say(magenta(`  ⟵ notifications/resources/updated ${n.params.uri} ${dim(JSON.stringify(n.params._meta ?? {}))}`)));

const transport = new StreamableHTTPClientTransport(new URL(URL_), { fetch: tappedFetch, requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
say(bold(`wire · era=${ERA} · token=${TOKEN} · ${URL_}`));
const t0 = Date.now();
await client.connect(transport);
const n0 = exchanges;
say(green(`\nconnected in ${exchanges} request${exchanges === 1 ? "" : "s"}, ${Date.now() - t0} ms: era ${bold(client.getProtocolEra())}, protocol ${bold(client.getNegotiatedProtocolVersion() ?? "?")}, server ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}`));
say(dim(`server capabilities ${JSON.stringify(client.getServerCapabilities())}`));
if (client.getDiscoverResult()) say(dim(`server/discover said: supportedVersions ${JSON.stringify(client.getDiscoverResult()!.supportedVersions)}, ttlMs ${client.getDiscoverResult()!.ttlMs}`));

try {
  switch (cmd) {
    case "handshake": break;
    case "tools": {
      for (const pass of [1, 2]) {
        const before = exchanges;
        const { tools } = await client.listTools();
        say(`\n${bold(`tools/list #${pass}`)}: ${tools.map((t) => t.name).join(", ")}  ${exchanges === before ? yellow("(served from the client's cache: no request went out)") : dim(`(${exchanges - before} request)`)}`);
      }
      break;
    }
    case "call": {
      const name = rest[0]; const a = rest[1] ? JSON.parse(rest[1]) : {};
      if (!name) { say("call <tool> [json]"); break; }
      const r = await client.callTool({ name, arguments: a }, { timeout: 10 * 60_000, resetTimeoutOnProgress: true, onprogress: (p) => say(dim(`  progress ${p.progress}/${p.total ?? "?"} ${p.message ?? ""}`)) });
      say(`\n${r.isError ? red("tool error") : green("result")}: ${(r.content as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join(" ")}`);
      break;
    }
    case "read": { const r = await client.readResource({ uri: rest[0] ?? "desk://status" }); for (const c of r.contents) say("text" in c ? c.text : "(binary)"); break; }
    case "listen": {
      const secs = Number(rest[0] ?? 60);
      if (client.getProtocolEra() !== "modern") {
        say(yellow(`\nsubscriptions/listen does not exist in ${client.getNegotiatedProtocolVersion()}. A 2025 client would open a GET stream and call resources/subscribe:`));
        try { await client.subscribeResource({ uri: "desk://status" }); } catch (e) { say(red(`  resources/subscribe → ${(e as Error).message}`)); }
        break;
      }
      const sub = await client.listen({ toolsListChanged: true, resourceSubscriptions: ["desk://status"] });
      say(green(`\nlistening for ${secs} s · honoured filter ${JSON.stringify(sub.honoredFilter)} · now freeze or deploy from another terminal`));
      await new Promise((r) => setTimeout(r, secs * 1000));
      await sub.close();
      say(dim("closed the subscription"));
      break;
    }
    default: say(`unknown command ${cmd}`);
  }
} catch (e) { say(red(`\n${(e as Error).name}: ${(e as Error).message}`)); }
say(dim(`\n${exchanges - n0} request${exchanges - n0 === 1 ? "" : "s"} after the handshake, ${exchanges} in total`));
rl.close();
await client.close();
