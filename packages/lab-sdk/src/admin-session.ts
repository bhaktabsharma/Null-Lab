import type { FastifyInstance } from "fastify";
import type { LabContext } from "./context.js";
import { signSession } from "./session.js";

/**
 * XSS-style labs need a way to show what an authenticated "admin" would
 * see, so the orchestrator's headless browser bot can render stored or
 * reflected content exactly as a privileged victim would. This registers
 * POST /__internal/admin-session, which mints that admin session cookie —
 * but ONLY for a caller that already holds this instance's own secret
 * token (never exposed to any browser; the control plane makes this one
 * server-to-server call and then hands the resulting cookie value to the
 * headless browser itself). The browser never sees or needs the token.
 */
export function registerAdminSession(app: FastifyInstance, ctx: LabContext, cookieName: string): void {
  app.post("/__internal/admin-session", async (req, reply) => {
    const token = req.headers["x-instance-token"];
    if (token !== ctx.instanceToken) {
      return reply.code(403).send({ error: "invalid instance token" });
    }
    const session = signSession(ctx.instanceToken, { user: "admin", role: "admin" });
    reply.setCookie(cookieName, session, { path: "/", httpOnly: true, sameSite: "lax" });
    return { ok: true };
  });
}
