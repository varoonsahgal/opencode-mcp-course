// itdesk: an IT-desk MCP server that cannot finish its work without the host's help.
//
// Every tool here needs something only the HOST can provide: a human's answer to a form, a browser
// to open an approval page, a model to borrow, the folders the user is working in, or somewhere to
// show progress. Point OpenCode at it and watch what a host without those features can do; then
// point your own host (host.ts) at it and watch the difference.
//
//   npx tsx itdesk.ts        (normally started by the host, not by you)
//   ITDESK_STEP_MS=300       faster checklist steps
//   ITDESK_APPROVAL_PORT     where the approval pages are served (default 8793)
import { McpServer, type ElicitRequestFormParams } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";

const APPROVAL_PORT = Number(process.env.ITDESK_APPROVAL_PORT ?? 8793);
const STEP_MS = Number(process.env.ITDESK_STEP_MS ?? 1000);
const STEPS = ["create accounts", "enrol in device management", "install dev tools", "configure VPN", "add to team channels", "schedule orientation"];
let ticketSeq = 1041;

const log = (s: string) => console.error(`[itdesk] ${s}`); // stderr: stdout is the protocol
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const refuse = (t: string) => ({ isError: true, content: [{ type: "text" as const, text: t }] });
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

// ---------------------------------------------------------------------------------------------
// Approval pages: the target of URL-mode elicitation. The host opens the link; a human clicks
// Approve or Deny; the tool that asked finds out. The model never sees this page.
// ---------------------------------------------------------------------------------------------
const approvals = new Map<string, { employee: string; system: string; resolve: (ok: boolean) => void }>();
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:17px/1.5 system-ui;max-width:540px;margin:60px auto;padding:0 20px;color:#231433">` +
  `<h1 style="font-size:26px">🖥️ IT desk</h1>${body}</body>`;
const approvalPages = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${APPROVAL_PORT}`);
  const m = url.pathname.match(/^\/approve\/([\w-]+)$/);
  const a = m ? approvals.get(m[1]) : undefined;
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (!m || !a) { res.writeHead(404).end(page("Nothing to approve", "<p>No pending approval at this address. It may already have been decided.</p>")); return; }
  if (req.method === "POST") {
    const ok = url.searchParams.get("decision") === "approve";
    approvals.delete(m[1]);
    a.resolve(ok);
    res.writeHead(200).end(page("Recorded", `<p>${ok ? "✅ Approved" : "⛔ Denied"}: <b>${a.employee}</b> → <b>${a.system}</b>. You can close this tab and go back to your terminal.</p>`));
    return;
  }
  res.writeHead(200).end(page("Approve access?",
    `<p><b>${a.employee}</b> is requesting access to <b>${a.system}</b>.</p><p style="color:#5d4e6e">Request ${m[1]} · this page is served by the IT desk server on your machine.</p>` +
    `<form method="post" action="?decision=approve" style="display:inline"><button style="font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#15803d;color:#fff">Approve</button></form> ` +
    `<form method="post" action="?decision=deny" style="display:inline"><button style="font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#e11d48;color:#fff">Deny</button></form>`));
});
approvalPages.on("error", (e) => log(`approval pages not available (${(e as Error).message}); grant_access will fail politely`));
approvalPages.listen(APPROVAL_PORT, "127.0.0.1", () => log(`approval pages on http://127.0.0.1:${APPROVAL_PORT}/approve/<id>`));

// ---------------------------------------------------------------------------------------------
// The server. One instance per connection (stdio has exactly one).
// ---------------------------------------------------------------------------------------------
const Answers = z.object({
  os: z.enum(["macOS", "Linux", "Windows"]).describe("Operating system"),
  keyboard: z.enum(["US", "UK", "DE"]).describe("Keyboard layout"),
  ship_to_office: z.boolean().describe("Ship to the office (true) or to the home address (false)"),
  notes: z.string().max(200).optional().describe("Anything else for IT"),
});
const FORM: ElicitRequestFormParams["requestedSchema"] = {
  type: "object",
  properties: {
    os: { type: "string", title: "Operating system", enum: ["macOS", "Linux", "Windows"] },
    keyboard: { type: "string", title: "Keyboard layout", enum: ["US", "UK", "DE"] },
    ship_to_office: { type: "boolean", title: "Ship to the office? (no = home address)", default: true },
    notes: { type: "string", title: "Anything else for IT?", maxLength: 200 },
  },
  required: ["os", "keyboard", "ship_to_office"],
};

serveStdio(() => {
  const server = new McpServer(
    { name: "itdesk", version: "1.0.0" },
    { capabilities: { logging: {} }, instructions: "IT desk for new-hire onboarding: laptops, access requests, setup checklists. Tools that need a person's decision ask the user through the host when the host allows it." },
  );
  // What did the host declare at initialize? Everything below is designed around the answer.
  const caps = () => server.server.getClientCapabilities() ?? {};
  const hostHas = (f: "elicitation" | "sampling" | "roots") => f in caps();
  const hostHasUrlElicitation = () => { const e = caps().elicitation as Record<string, unknown> | undefined; return !!e && "url" in e; };

  // 1. A form the user fills in. Design for the floor: the answers can also arrive as arguments, so a
  //    host without elicitation is not a dead end; it is just a longer conversation.
  const provision = server.registerTool("provision_laptop", {
    title: "Provision a laptop",
    description: "Order and configure a laptop for a new hire. Needs the OS, keyboard layout and shipping choice: pass them in `answers` if you already know them, or omit `answers` and the desk asks the person directly (that only works in a host that supports elicitation). Not for replacements or repairs.",
    inputSchema: z.object({
      employee: z.string().min(2).describe("Full name of the new hire"),
      answers: Answers.optional().describe("Leave out to let the desk ask the user; provide if the user already told you"),
    }),
    outputSchema: z.object({ ticket: z.string(), employee: z.string(), os: z.string(), keyboard: z.string(), ship_to_office: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ employee, answers }, ctx) => {
    let a = answers;
    if (!a) {
      if (!hostHas("elicitation")) {
        log(`provision_laptop for ${employee}: host has no elicitation, asking the model to ask the user`);
        return refuse(`I cannot ask ${employee}'s questions through this host (it declared no elicitation capability). Ask the user for: os (macOS, Linux or Windows), keyboard (US, UK or DE) and ship_to_office (yes or no), then call provision_laptop again with those in \`answers\`.`);
      }
      log(`provision_laptop for ${employee}: asking the host to collect the answers (elicitation/create)`);
      await ctx.mcpReq.log("info", `collecting laptop preferences for ${employee}`);
      const r = await ctx.mcpReq.elicitInput({ mode: "form", message: `Provisioning a laptop for ${employee}. A few questions:`, requestedSchema: FORM }, { timeout: 10 * 60_000 });
      if (r.action !== "accept") { log(`provision_laptop for ${employee}: user ${r.action}d`); return refuse(`The user ${r.action === "decline" ? "declined to answer" : "cancelled"}. Nothing was ordered for ${employee}.`); }
      const parsed = Answers.safeParse(r.content);
      if (!parsed.success) return refuse(`The answers did not validate: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      a = parsed.data;
    }
    if ((a as { admin_rights?: boolean }).admin_rights) log(`⚠ admin rights requested for ${employee}`);
    const ticket = `ITD-${++ticketSeq}`;
    log(`✎ ${ticket}: ${a.os} laptop, ${a.keyboard} keyboard for ${employee}, ${a.ship_to_office ? "ship to the office" : "ship to home"}${a.notes ? ` · notes: ${a.notes}` : ""}`);
    return {
      content: [{ type: "text", text: `Ticket ${ticket}: a ${a.os} laptop with a ${a.keyboard} keyboard for ${employee}, shipped to ${a.ship_to_office ? "the office" : "their home address"}.` }],
      structuredContent: { ticket, employee, os: a.os, keyboard: a.keyboard, ship_to_office: a.ship_to_office },
    };
  });

  // 2. A decision made in a browser, on a page the model never sees: URL-mode elicitation.
  server.registerTool("grant_access", {
    title: "Request access to a system",
    description: "File an access request for a new hire to an internal system. A human approves or denies it on a web page; the tool waits up to two minutes for the decision. Use when the user asks to give someone access.",
    inputSchema: z.object({ employee: z.string().min(2).describe("Full name"), system: z.enum(["github", "vpn", "payroll", "prod-db"]).describe("System to grant access to") }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ employee, system }, ctx) => {
    if (!hostHasUrlElicitation()) {
      log(`grant_access ${employee} → ${system}: host cannot open a URL for the user`);
      return refuse(`This host cannot send the user to an approval page (no URL elicitation). Tell the user to ask an IT admin to approve ${employee}'s access to ${system} manually.`);
    }
    const id = randomUUID().slice(0, 8);
    const url = `http://127.0.0.1:${APPROVAL_PORT}/approve/${id}`;
    const decision = new Promise<boolean>((resolve) => approvals.set(id, { employee, system, resolve }));
    log(`grant_access ${employee} → ${system}: approval ${id} at ${url}`);
    const r = await ctx.mcpReq.elicitInput({ mode: "url", url, elicitationId: id, message: `Approve or deny ${employee}'s access to ${system} in your browser.` }, { timeout: 2 * 60_000 });
    if (r.action !== "accept") { approvals.delete(id); return refuse(`The user ${r.action}d opening the approval page. No request filed for ${employee}.`); }
    const ok = await Promise.race([decision, sleep(120_000, ctx.mcpReq.signal).then(() => null)]);
    approvals.delete(id);
    try { await server.server.createElicitationCompletionNotifier(id)(); } catch { /* 2026-era connections have no such notification */ }
    if (ok === null) return refuse(`No decision for ${employee} → ${system} within two minutes (or the call was cancelled). Request ${id} dropped.`);
    log(`${ok ? "✔ approved" : "✘ denied"}: ${employee} → ${system} (request ${id})`);
    return text(ok ? `Access to ${system} approved for ${employee} (request ${id}).` : `Access to ${system} was denied for ${employee} (request ${id}).`);
  });

  // 3. Slow work that reports progress and stops when the user stops.
  server.registerTool("run_setup_checklist", {
    title: "Run the setup checklist",
    description: "Run the six-step setup checklist for a new hire (accounts, device management, dev tools, VPN, channels, orientation). Takes several seconds and reports progress. Safe to repeat.",
    inputSchema: z.object({ employee: z.string().min(2).describe("Full name") }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ employee }, ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    log(`checklist for ${employee} ${token === undefined ? "(the host did not ask for progress)" : `(progressToken ${JSON.stringify(token)})`}`);
    for (const [i, step] of STEPS.entries()) {
      if (ctx.mcpReq.signal.aborted) { log(`checklist for ${employee} cancelled by the host at step ${i + 1}/${STEPS.length}`); return refuse(`Setup checklist for ${employee} cancelled after ${i} of ${STEPS.length} steps.`); }
      if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: i, total: STEPS.length, message: step } });
      await sleep(STEP_MS, ctx.mcpReq.signal);
    }
    if (ctx.mcpReq.signal.aborted) return refuse(`Setup checklist for ${employee} cancelled at the last step.`);
    if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: STEPS.length, total: STEPS.length, message: "done" } });
    log(`checklist for ${employee} complete`);
    return text(`Setup checklist for ${employee} complete: ${STEPS.join(", ")}.`);
  });

  // 4. Borrowing the host's model: sampling. Deprecated in the 2026-07-28 revision (SEP-2577); it is
  //    here so you can see it once, and see why "call your own model provider" replaced it.
  server.registerTool("draft_welcome", {
    title: "Draft a welcome note",
    description: "Draft a two-sentence welcome note for a new hire, written by the host's own model (sampling). Use when the user asks for a welcome note.",
    inputSchema: z.object({ employee: z.string().min(2), team: z.string().min(2).describe("Team they are joining") }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ employee, team }, ctx) => {
    if (!hostHas("sampling")) return refuse(`This host does not lend out its model (no sampling capability). Write the note yourself: two warm sentences welcoming ${employee} to the ${team} team.`);
    log(`draft_welcome for ${employee}: asking the host's model (sampling/createMessage)`);
    try {
      const r = await ctx.mcpReq.requestSampling({
        systemPrompt: "You write short, warm, professional onboarding notes.",
        messages: [{ role: "user", content: { type: "text", text: `Write a two-sentence welcome note for ${employee}, who joins the ${team} team on Monday.` } }],
        maxTokens: 120,
      }, { timeout: 60_000 });
      const out = Array.isArray(r.content) ? r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("") : r.content.type === "text" ? r.content.text : `[${r.content.type}]`;
      return text(`Draft, written by the host's model "${r.model}":\n\n${out}`);
    } catch (e) { return refuse(`Sampling failed: ${(e as Error).message}`); }
  });

  // 5. Where is the user working? Roots. Also deprecated in 2026-07-28: pass paths as arguments instead.
  server.registerTool("where_am_i", {
    title: "Where is the user working?",
    description: "Report which project folders (roots) the host says the user is working in. Read-only.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    if (!hostHas("roots")) return refuse("This host declared no roots capability, so I cannot tell where the user is working.");
    try {
      const r = await server.server.listRoots();
      return text(r.roots.length ? `The host says the user works in: ${r.roots.map((x) => `${x.name ? x.name + " " : ""}${x.uri}`).join(", ")}` : "The host declared roots but listed none.");
    } catch (e) { return refuse(`roots/list failed: ${(e as Error).message}`); }
  });

  // 6. The server changes under the host's feet: a tool definition is updated and list_changed is sent.
  server.registerTool("simulate_update", {
    title: "Simulate a server update",
    description: "Pretend the IT desk shipped v1.1, in which provision_laptop gains an admin_rights option. Sends tools/list_changed to the host. Only when the user asks to simulate an update.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    provision.update({
      description: (provision.description ?? "") + " v1.1: set answers.admin_rights to true to grant local administrator rights on the laptop.",
      paramsSchema: z.object({ employee: z.string().min(2).describe("Full name of the new hire"), answers: Answers.extend({ admin_rights: z.boolean().optional().describe("Grant local admin rights") }).optional() }),
    });
    log("✎ itdesk is now v1.1: provision_laptop changed, tools/list_changed sent to the host");
    return text("IT desk updated to v1.1: provision_laptop now accepts answers.admin_rights.");
  });

  // A resource and a prompt, so a host has all three primitives to show.
  server.registerResource("onboarding-policy", "itdesk://policy", { title: "Onboarding policy", description: "What a new hire gets by default and who approves exceptions.", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Onboarding policy\n\n- Every new hire gets one laptop (macOS, Linux or Windows) and a US, UK or DE keyboard.\n- Access to github and vpn is standard; payroll and prod-db need a named approver.\n- Local admin rights are not granted by default.\n" }],
  }));
  server.registerPrompt("onboard", { title: "Onboard a new hire", description: "Provision a laptop, request standard access and run the setup checklist for one person.", argsSchema: z.object({ employee: z.string().describe("Full name"), team: z.string().describe("Team") }) }, ({ employee, team }) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: `Onboard ${employee}, who joins the ${team} team: provision a laptop (ask them their preferences), request github and vpn access, then run the setup checklist. Report the ticket number at the end.` } }],
  }));

  return server;
});
