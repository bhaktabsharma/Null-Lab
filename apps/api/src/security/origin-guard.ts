import type { FastifyInstance } from "fastify";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Builds the set of browser origins allowed to make state-changing calls to
 * the control-plane API: the configured web origin(s) and the control
 * plane's own origin, each under both common loopback host spellings.
 *
 * Lab targets are deliberately NOT in this set. They run attacker-controlled
 * JavaScript by design (the XSS labs), on the same machine, so a page served
 * by a lab must never be able to launch, reset, or stop instances using the
 * learner's logged-in cookie.
 */
export function buildAllowedOrigins(webOrigins: string, apiPort: number): Set<string> {
  const out = new Set<string>();
  const add = (origin: string) => out.add(origin.replace(/\/$/, ""));

  for (const raw of webOrigins.split(",").map((s) => s.trim()).filter(Boolean)) {
    add(raw);
    try {
      const u = new URL(raw);
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
        for (const host of ["localhost", "127.0.0.1"]) add(`${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`);
      }
    } catch {
      /* ignore malformed entries; zod validated the string only as a string */
    }
  }
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) add(`http://${host}:${apiPort}`);
  return out;
}

/**
 * CSRF defence for cookie-authenticated /api routes.
 *
 * A browser always attaches an Origin header to a cross-origin POST/PUT/
 * PATCH/DELETE and page script cannot remove or forge it, so: if Origin is
 * present it must be allow-listed (this also rejects `Origin: null`). If
 * Origin is absent the request did not come from a cross-origin browser
 * page (curl, Burp Repeater, scripts); as a second guard, a browser-supplied
 * Sec-Fetch-Site that says the request was cross-site is refused.
 *
 * `/internal/*` is not covered: it is only reachable with a per-instance
 * secret token and is called by lab targets, not browsers.
 */
export function registerOriginGuard(app: FastifyInstance, allowed: Set<string>): void {
  app.addHook("onRequest", async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) return;
    if (!(req.raw.url ?? "").startsWith("/api/")) return;

    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!allowed.has(origin)) {
        return reply.code(403).send({ error: "Cross-origin request blocked." });
      }
      return;
    }
    const fetchSite = req.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") {
      return reply.code(403).send({ error: "Cross-site request blocked." });
    }
  });
}
