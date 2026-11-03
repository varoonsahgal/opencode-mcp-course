#!/usr/bin/env node
// audit.mjs: read the gateway's audit trail.
//   node audit.mjs                 every line, one per decision
//   node audit.mjs --user alice    only one person
//   node audit.mjs --deny          only refusals
//   node audit.mjs --trace <id>    one call, everything known about it
import { existsSync, readFileSync } from "node:fs";

const FILE = new URL("./audit.jsonl", import.meta.url).pathname;
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
if (!existsSync(FILE)) { console.log("no audit.jsonl yet: make some calls through the gateway"); process.exit(0); }
let lines = readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
if (opt("--user")) lines = lines.filter((l) => l.user === opt("--user"));
if (args.includes("--deny")) lines = lines.filter((l) => l.decision === "deny");
if (opt("--trace")) { for (const l of lines.filter((l) => l.trace.startsWith(opt("--trace")))) console.log(JSON.stringify(l, null, 2)); process.exit(0); }
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
for (const l of lines) {
  const d = l.decision === "deny" ? c("31", "DENY ") : l.decision === "release" ? c("35", "REL  ") : c("32", "ALLOW");
  console.log(`${new Date(l.ts).toTimeString().slice(0, 8)} ${d} ${String(l.user).padEnd(6)} ${String(l.tool ?? l.target).padEnd(28)} ${c("2", (l.reason ?? "").slice(0, 52).padEnd(52))}${l.redactions ? c("33", ` · ${l.redactions} redacted`) : ""}${l.ms !== undefined ? c("2", ` · ${l.ms} ms`) : ""} ${c("2", l.trace.slice(0, 8))}`);
}
const by = (k) => Object.entries(lines.reduce((a, l) => ((a[l[k]] = (a[l[k]] ?? 0) + 1), a), {})).map(([x, n]) => `${x} ${n}`).join(" · ");
console.log(c("2", `\n${lines.length} lines · by person: ${by("user")} · by decision: ${by("decision")}`));
