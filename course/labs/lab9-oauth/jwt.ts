// A minimal JWT (HS256) for the lab: sign, verify the signature, decode. Shared by the authorization
// server (which mints) and the desk (which verifies). Production uses asymmetric keys (RS256/ES256)
// published as a JWKS, so a resource server can verify without being able to mint; the shape of the
// claims and the checks you make on them are the same.
import { createHmac, timingSafeEqual } from "node:crypto";

export type Claims = { iss: string; sub: string; aud: string; scope: string; exp: number; iat: number; jti: string; client_id: string };
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function sign(claims: Claims, secret: string): string {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** Verifies the signature only. Whether the claims are acceptable (issuer, audience, expiry) is the caller's job. */
export function verifySignature(token: string, secret: string): Claims {
  const [head, body, sig] = token.split(".");
  if (!head || !body || !sig) throw new Error("not a JWT");
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("bad signature");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
}

/** Decodes without verifying: for printing, never for trusting. */
export function decode(token: string): Claims | undefined {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch { return undefined; }
}
