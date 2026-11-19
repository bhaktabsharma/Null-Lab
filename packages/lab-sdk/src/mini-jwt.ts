/**
 * MiniJWT — a tiny, honest HS256 JSON Web Token encoder/decoder for auth labs.
 * `sign()` always produces a correctly HMAC-SHA256-signed token; it is the
 * baseline "how this is supposed to work." Each lab's own server.ts writes
 * its OWN verify function with a specific, deliberate flaw (accepting
 * "alg":"none", trusting an unverified claim, etc.) using the `decode()`
 * and `hmacSha256Base64Url()` building blocks below — the flaw lives in the
 * lab, not hidden in shared code.
 */
import { createHmac } from "node:crypto";

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

export function hmacSha256Base64Url(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
  signingInput: string;
}

/** Splits and base64url-decodes a token's three parts WITHOUT verifying anything. */
export function decode(token: string): JwtParts | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return { header, payload, signature: parts[2]!, signingInput: `${parts[0]}.${parts[1]}` };
  } catch {
    return null;
  }
}

/** A correctly-signed HS256 token. */
export function sign(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${hmacSha256Base64Url(signingInput, secret)}`;
}
