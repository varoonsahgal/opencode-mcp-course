#!/usr/bin/env node
// issue-tokens: rotate the release desk's tokens.
//
// Generates a fresh random token per person, prints each one ONCE to this terminal, and writes
// only their SHA-256 hashes to tokens.json. A hash is useless as a bearer token, so anyone (or any
// agent) who reads tokens.json or server.ts learns nothing they can replay.
//
//   node issue-tokens.mjs        -> new tokens for alice, bob and carol; old ones stop working
//                                   the next time the server starts
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const PEOPLE = {
  alice: ["releases:read"],
  bob: ["releases:read", "releases:deploy"],
  carol: ["releases:read", "releases:deploy", "releases:freeze"],
};

const table = {};
console.log("New release-desk tokens. Hand each one to its owner; they are not stored anywhere:\n");
for (const [user, scopes] of Object.entries(PEOPLE)) {
  const token = `desk_${user}_${randomBytes(18).toString("base64url")}`;
  table[createHash("sha256").update(token).digest("hex")] = { user, scopes };
  console.log(`  ${user.padEnd(6)} DESK_TOKEN=${token}`);
}
writeFileSync(new URL("./tokens.json", import.meta.url), JSON.stringify(table, null, 2) + "\n");
console.log("\nWrote tokens.json (hashes only). Restart the server to load it.");
