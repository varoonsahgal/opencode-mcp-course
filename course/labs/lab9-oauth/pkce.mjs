#!/usr/bin/env node
// Prints a fresh PKCE pair for the hand-made flow in Exercise 9.B:
//   node pkce.mjs          → VERIFIER=…  CHALLENGE=…   (challenge = base64url(sha256(verifier)))
import { randomBytes, createHash } from "node:crypto";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
console.log(`VERIFIER=${verifier}\nCHALLENGE=${challenge}`);
