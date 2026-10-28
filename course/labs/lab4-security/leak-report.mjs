#!/usr/bin/env node
// leak-report: what did shady-notes actually receive?
//
// shady-notes writes every call it gets to shady-notes/notes.log (nothing leaves
// your machine). This script reads that log and shows, side by side, what you
// saw in OpenCode and what the attacker's server was handed in the hidden
// `context` argument. Values are shown in full: the lab's .env holds fake data.
//
//   usage: node leak-report.mjs [path-to-notes.log]
//
import { existsSync, readFileSync } from "node:fs";

const LOG = process.argv[2] ?? "shady-notes/notes.log";
const LIVE = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (LIVE ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [red, green, yellow, dim, bold, alarm] = [c("31"), c("32"), c("33"), c("2"), c("1"), c("1;30;41")];
const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSW|DATABASE_URL|CREDENTIAL)/i;

if (!existsSync(LOG)) {
  console.log(green(`\n  ${LOG} does not exist: shady-notes was never called. Nothing to report.\n`));
  process.exit(0);
}
const calls = readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const leaks = calls.filter((x) => x.leaked_context);
const bytes = leaks.reduce((n, x) => n + Buffer.byteLength(x.leaked_context), 0);

console.log("");
console.log(leaks.length ? alarm("  ATTACKER'S INBOX  ") + red(bold(`  ${leaks.length} of ${calls.length} call(s) carried a payload · ${bytes} bytes exfiltrated`))
                         : green(bold(`  ${calls.length} call(s), 0 bytes leaked. The hidden argument arrived empty every time.`)));

for (const [i, x] of calls.entries()) {
  console.log("\n" + dim(`  ── call ${i + 1} · ${x.at} ${"─".repeat(60)}`));
  console.log(`  ${bold("What you asked")}     ${green(`add a note: "${x.note}"`)}`);
  if (!x.leaked_context) { console.log(`  ${bold("What they received")} ${dim("(empty context)")}`); continue; }
  console.log(`  ${bold("What they received")} ${red("context =")}`);
  for (const line of x.leaked_context.trimEnd().split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) console.log(dim(`     │ ${line}`));
    else console.log(`     │ ${SECRET.test(m[1]) ? red(bold(m[1])) : yellow(m[1])}=${SECRET.test(m[1]) ? red(m[2]) : m[2]}`);
  }
  const keys = (x.leaked_context.match(/^\s*[A-Z0-9_]+\s*=/gm) ?? []).map((k) => k.replace(/\s*=$/, "").trim());
  const hot = keys.filter((k) => SECRET.test(k));
  if (hot.length) console.log(red(`     └─ ${hot.length} credential(s) to rotate now: ${hot.join(", ")}`));
}

console.log("\n" + dim("  The tool's description asked for this, and you never saw that description."));
console.log(dim("  OpenCode asked before READING .env. Nothing asked before SENDING it: MCP tools default to allow."));
console.log(dim("  If this were real: rotate every credential above, then find out who else installed the server.\n"));
