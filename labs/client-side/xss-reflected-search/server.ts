/**
 * SupportDesk — Reflected Search XSS
 *
 * GET /search?q=<term> drops the raw search term straight into the
 * response HTML with no encoding. Proof of exploitation can't be a
 * reflected-string match — it has to be real script execution. So: when
 * (and only when) the request carries a valid *admin* session, the page
 * also renders a hidden element holding a per-instance secret that no
 * other session can see. A real XSS payload must read that element and
 * exfiltrate it to /collect; the orchestrator's headless admin bot is
 * what actually authenticates as admin and visits the attacker-crafted
 * URL (see apps/api/instances/admin-bot.ts).
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  parseCookies,
  verifySession,
  adminSecretFor,
  registerAdminSession,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const ADMIN_COOKIE = "supportdesk_xss_admin";
const SECRET = adminSecretFor(ctx, "reflected-search");

function isAdmin(cookieHeader: string | undefined): boolean {
  const session = verifySession<{ role: string }>(ctx.instanceToken, parseCookies(cookieHeader)[ADMIN_COOKIE]);
  return session?.role === "admin";
}

function shell(title: string, body: string) {
  return renderShell(title, body, { appName: "SupportDesk", accent: "#e0a63f", navLinks: [{ href: "/search", label: "Search" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: "SupportDesk" });
  registerAdminSession(app, ctx, ADMIN_COOKIE);

  app.get("/", async (_req, reply) => reply.redirect("/search"));

  // --- The vulnerable handler -------------------------------------------------
  app.get("/search", async (req, reply) => {
    const q = String((req.query as { q?: string }).q ?? "");
    const admin = isAdmin(req.headers.cookie);

    reply.type("text/html");
    return shell(
      "Help Centre Search",
      `<div class="panel">
        <h1>Search the help centre</h1>
        <form method="get" action="/search">
          <p><input type="text" name="q" placeholder="What do you need help with?" /></p>
          <button type="submit">Search</button>
        </form>
        ${admin ? `<span id="admin-token" data-token="${SECRET}" style="display:none"></span>` : ""}
        ${
          q
            ? // VULNERABLE: the raw query is dropped directly into the HTML, unescaped.
              `<div class="panel" style="background:#0b0e13;margin-top:1rem;"><p>No help articles found for: ${q}</p></div>`
            : ""
        }
      </div>`,
    );
  });

  // --- Exfiltration endpoint (the payload's target, not the solve logic itself) ---
  app.get("/collect", async (req, reply) => {
    const token = String((req.query as { token?: string }).token ?? "");
    if (token === SECRET) {
      await reportSolve(ctx, `a script running in the admin session exfiltrated the admin token to GET /collect, proving reflected XSS at /search?q=...`);
    }
    reply.header("content-type", "image/gif");
    // A tiny 1x1 transparent GIF so an <img> beacon payload renders cleanly too.
    return reply.send(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7", "base64"));
  });

  await startLabApp(app, ctx, "SupportDesk");
}

main().catch((err) => {
  console.error("[supportdesk-xss-reflected] fatal error:", err);
  process.exit(1);
});
