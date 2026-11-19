import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal signed-cookie session for a lab target's OWN synthetic users
 * (e.g. "alice" / "bob" inside a single IDOR lab). This is deliberately
 * separate from NULLLAB's control-plane authentication — it models the
 * target application's own login system, scoped to one instance, signed
 * with that instance's unique token so no other instance (or the control
 * plane) can forge or read it.
 */
export function signSession(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession<T = Record<string, unknown>>(secret: string, token: string | undefined | null): T | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Parses a `name=value; other=value2` Cookie header into a plain object. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
