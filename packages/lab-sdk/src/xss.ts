import { createHmac } from "node:crypto";
import type { LabContext } from "./context.js";

/**
 * XSS labs cannot be verified by a reflected string match — that proves
 * nothing about script execution. Instead, each instance gets a unique
 * "admin secret" token that is rendered into the DOM ONLY during a
 * simulated privileged ("admin") browsing session, in an element a normal
 * visitor's own request never sees in its own response body content it
 * controls. The lab's genuine stored/reflected injection point is the only
 * way for a payload to run inside that admin session and read the token.
 * A correct payload must exfiltrate the token to this lab's own /collect
 * endpoint (e.g. via fetch/image-beacon) — the orchestrator's headless
 * "admin bot" is what actually loads the page as the privileged session.
 */
export function adminSecretFor(ctx: LabContext, scopeKey: string): string {
  return createHmac("sha256", ctx.instanceToken).update(scopeKey).digest("hex").slice(0, 24);
}
