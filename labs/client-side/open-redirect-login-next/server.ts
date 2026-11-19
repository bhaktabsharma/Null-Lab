/**
 * GoShort — Back Where You Came From (open redirect)
 *
 * POST /login validates `next` with `next.startsWith("/")` — which a
 * protocol-relative URL ("//evil.test/...") also satisfies, even though
 * browsers resolve a leading "//" as an absolute URL to another host.
 * Recorded only when a REAL successful login's redirect Location resolves
 * to a host other than the app's own.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, makeSessions } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "GoShort";
const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const sessions = makeSessions<{ user: string }>(ctx, "gs_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#ffb020", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/links", label: "My links" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
}

// VULNERABLE: accepts anything starting with "/", including "//host" (protocol-relative).
function looksInternal(next: string): boolean {
  return next.startsWith("/");
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (req, reply) => reply.redirect(sessions.read(req) ? "/links" : "/login"));

  app.get("/login", async (req, reply) => {
    const next = String((req.query as { next?: string }).next ?? "/links");
    const err = (req.query as { error?: string }).error;
    reply.type("text/html");
    return shell(
      "Sign in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Sign in to GoShort</h1>
        ${err ? `<p style="color:#e07a7a;">Incorrect username or password.</p>` : ""}
        <form method="post" action="/login">
          <input type="hidden" name="next" value="${escapeHtml(next)}" />
          <p><input type="text" name="username" placeholder="Username" /></p>
          <p><input type="password" name="password" placeholder="Password" /></p>
          <button type="submit">Sign in</button>
        </form>
        <p class="muted">Demo: <strong>alice</strong> / practice123</p></div>`,
    );
  });

  app.post("/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown; next?: unknown };
    const next = typeof b.next === "string" && b.next.length <= 300 ? b.next : "/links";
    const user = USERS.find((u) => typeof b.username === "string" && typeof b.password === "string" && u.username === b.username && u.password === b.password);
    if (!user) return reply.redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
    sessions.set(reply, { user: user.username });

    // VULNERABLE: the validated-looking "next" is used as the redirect target verbatim.
    const destination = looksInternal(next) ? next : "/links";
    const hostOfThisApp = req.headers.host ?? "";
    const foreign = new URL(destination, `http://${hostOfThisApp}`).host !== hostOfThisApp;
    if (foreign) {
      await reportSolve(ctx, `login redirected to "${destination}", which resolves to a different host than the application's own`);
    }
    return reply.redirect(destination);
  });

  app.get("/links", async (req, reply) => {
    const s = sessions.read(req);
    if (!s) return reply.redirect("/login");
    const user = USERS.find((u) => u.username === s.user)!;
    reply.type("text/html");
    return shell("My links", `<div class="panel"><h1>Welcome, ${escapeHtml(user.displayName)}</h1><p class="muted">No links saved yet.</p></div>`, user.displayName);
  });

  app.get("/logout", async (_req, reply) => {
    sessions.clear(reply);
    return reply.redirect("/login");
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[goshort] fatal error:", err);
  process.exit(1);
});
