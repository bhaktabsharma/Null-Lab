/**
 * NotaryFlow — Logged Out, Still In (session invalidation failure)
 *
 * /logout calls reply.clearCookie(), which only tells the BROWSER to drop
 * the cookie — it never removes the session from the server-side store.
 * Recorded only when a request replaying the OLD token succeeds on the
 * protected page after that same session's logout has completed.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell } from "@nulllab/lab-sdk";
import { randomBytes } from "node:crypto";

const ctx = loadLabContext();
const APP = "NotaryFlow";
const USER = { username: "alice", password: "practice123", displayName: "Alice Chen" };
const COOKIE = `nf_session_${ctx.port}`;

const sessions = new Map<string, { user: string }>(); // token -> session (VULNERABLE: never deleted on logout)
function parseCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
}

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#9b7bd8", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/documents", label: "Documents" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (req, reply) => reply.redirect(parseCookie(req.headers.cookie, COOKIE) ? "/documents" : "/login"));

  app.get("/login", async (_req, reply) => {
    reply.type("text/html");
    return shell("Sign in", `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Sign in to NotaryFlow</h1>
      <form method="post" action="/login"><p><input type="text" name="username" placeholder="Username" /></p>
      <p><input type="password" name="password" placeholder="Password" /></p><button type="submit">Sign in</button></form>
      <p class="muted">Demo: <strong>alice</strong> / practice123</p></div>`);
  });

  app.post("/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (b.username !== USER.username || b.password !== USER.password) {
      reply.code(401);
      reply.type("text/html");
      return shell("Sign in", `<div class="panel" style="max-width:380px;margin:3rem auto;"><p style="color:#e07a7a;">Incorrect username or password.</p></div>`);
    }
    const token = randomBytes(16).toString("hex");
    sessions.set(token, { user: USER.username });
    reply.setCookie(COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax" });
    return reply.redirect("/documents");
  });

  app.get("/documents", async (req, reply) => {
    const token = parseCookie(req.headers.cookie, COOKIE);
    const s = token ? sessions.get(token) : undefined;
    if (!s) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Documents", `<div class="panel"><h1>Your documents</h1><p class="muted">4 documents pending signature.</p></div>`, s.user);
  });

  // --- The vulnerable handler: clears the cookie, never the server-side session. --
  app.get("/logout", async (req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return reply.redirect("/login");
  });

  app.get("/__check/replay", async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    if (!token) return reply.code(400).send({ error: "token required" });
    const s = sessions.get(token);
    if (!s) return { valid: false };
    await reportSolve(ctx, `a session token issued at login still resolved to user "${s.user}" after that session's /logout had already been called`);
    return { valid: true, user: s.user };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[notaryflow] fatal error:", err);
  process.exit(1);
});
