/**
 * ConnectHub — Sign in with ShopSphere (OAuth redirect_uri validation bypass)
 *
 * A mock identity provider ("ShopSphere") lives in the SAME process as the
 * relying party ("ConnectHub"), under /idp/*, with no real network involved
 * and no real IdP credentials anywhere. /idp/authorize validates redirect_uri
 * with `startsWith(registered)` instead of an exact match, so
 * "https://connecthub.test.callback/oauth/callback.attacker.test" or
 * "https://connecthub.test.callback@attacker.test" both pass the check while
 * resolving to an attacker-controlled host. Recorded only when a REAL
 * authorization code is actually issued to a redirect_uri whose own host is
 * not the registered callback host.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml } from "@nulllab/lab-sdk";
import { randomBytes } from "node:crypto";

const ctx = loadLabContext();
const APP = "ConnectHub";
const REGISTERED_REDIRECT = "https://connecthub.test.callback/oauth/callback"; // what the real client is registered for
const REGISTERED_HOST = new URL(REGISTERED_REDIRECT).host;
const CLIENT_ID = "connecthub-client";
const codes = new Map<string, { redirectUri: string; user: string }>();

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#8ad1ff", navLinks: [{ href: "/", label: "Home" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    const authorizeUrl = `/idp/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REGISTERED_REDIRECT)}&response_type=code&state=xyz`;
    return shell(
      "ConnectHub",
      `<div class="panel"><h1>ConnectHub</h1>
        <p class="muted">ConnectHub itself has nothing sensitive — what matters here is the identity provider's authorize endpoint.</p>
        <p><a class="link" href="${authorizeUrl}">Sign in with ShopSphere</a></p></div>`,
    );
  });

  // The relying party's own callback — would normally exchange the code for a session.
  app.get("/oauth/callback", async (req, reply) => {
    const code = (req.query as { code?: string }).code;
    reply.type("text/html");
    return shell("Signed in", `<div class="panel"><p>Received code: ${escapeHtml(code ?? "(none)")}</p></div>`);
  });

  // --- The mock identity provider --------------------------------------------
  app.get("/idp/authorize", async (req, reply) => {
    const q = req.query as { client_id?: string; redirect_uri?: string; state?: string };
    reply.type("text/html");
    if (q.client_id !== CLIENT_ID || !q.redirect_uri) {
      reply.code(400);
      return shell("Error", `<div class="panel"><p>Invalid request.</p></div>`);
    }

    // VULNERABLE: prefix/substring check instead of an exact match against the registered URI.
    const looksRegistered = q.redirect_uri.startsWith(REGISTERED_REDIRECT) || q.redirect_uri.includes(REGISTERED_HOST);
    if (!looksRegistered) {
      reply.code(400);
      return shell("Error", `<div class="panel"><p>redirect_uri is not registered for this client.</p></div>`);
    }

    return shell(
      "ShopSphere — Authorize",
      `<div class="panel" style="max-width:420px;margin:3rem auto;"><h1>Authorize ConnectHub?</h1>
        <p class="muted">ConnectHub is requesting access to your ShopSphere profile.</p>
        <form method="post" action="/idp/consent">
          <input type="hidden" name="redirect_uri" value="${escapeHtml(q.redirect_uri)}" />
          <input type="hidden" name="state" value="${escapeHtml(q.state ?? "")}" />
          <button type="submit">Allow</button>
        </form></div>`,
    );
  });

  app.post("/idp/consent", async (req, reply) => {
    const b = (req.body ?? {}) as { redirect_uri?: unknown; state?: unknown };
    const redirectUri = typeof b.redirect_uri === "string" ? b.redirect_uri : "";
    const code = randomBytes(12).toString("hex");
    codes.set(code, { redirectUri, user: "shopsphere-demo-user" });

    let actualHost = "";
    try {
      actualHost = new URL(redirectUri).host;
    } catch {
      /* malformed — handled below */
    }
    if (actualHost && actualHost !== REGISTERED_HOST) {
      await reportSolve(ctx, `the identity provider issued a real authorization code to redirect_uri "${redirectUri}" (host "${actualHost}"), which is not the registered callback host "${REGISTERED_HOST}"`);
    }

    const sep = redirectUri.includes("?") ? "&" : "?";
    return reply.redirect(`${redirectUri}${sep}code=${code}&state=${encodeURIComponent(typeof b.state === "string" ? b.state : "")}`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[connecthub] fatal error:", err);
  process.exit(1);
});
