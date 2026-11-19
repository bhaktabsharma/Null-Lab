/**
 * PantryPal — Remember This Device (predictable remember-me token)
 *
 * The persistent login cookie is `md5(username + ":remember")` — a value
 * anyone can recompute for any known username, rather than a random secret
 * generated at login and stored server-side per account. Recorded only when
 * a remember-me cookie that this instance never actually issued (i.e.
 * nobody ever logged in as that account with "remember me") still grants an
 * authenticated session for the 'admin' account.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml } from "@nulllab/lab-sdk";
import { createHash, randomBytes } from "node:crypto";

const ctx = loadLabContext();
const APP = "PantryPal";
const USERS = [
  { username: "alice", password: "practice123" },
  { username: "admin", password: randomBytes(16).toString("hex") }, // unknown to the learner
];
const REMEMBER_COOKIE = `pp_remember_${ctx.port}`;
const SESSION_COOKIE = `pp_session_${ctx.port}`;
const issuedRememberTokens = new Set<string>(); // tokens this server actually handed out via a real login

// VULNERABLE: derived from public info (the username) instead of a stored random secret.
function rememberTokenFor(username: string): string {
  return createHash("md5").update(`${username}:remember`).digest("hex");
}

const sessions = new Map<string, string>(); // session token -> username
function parseCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
}

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#7fd4a0", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/login", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Sign in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Sign in to PantryPal</h1>
        <form method="post" action="/login"><p><input type="text" name="username" placeholder="Username" /></p>
        <p><input type="password" name="password" placeholder="Password" /></p>
        <p><label><input type="checkbox" name="remember" value="1" /> Remember me on this device</label></p>
        <button type="submit">Sign in</button></form><p class="muted">Demo: <strong>alice</strong> / practice123</p></div>`,
    );
  });

  app.post("/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown; remember?: unknown };
    const user = USERS.find((u) => u.username === b.username && u.password === b.password);
    reply.type("text/html");
    if (!user) {
      reply.code(401);
      return shell("Sign in", `<div class="panel"><p style="color:#e07a7a;">Incorrect username or password.</p></div>`);
    }
    const sessionToken = randomBytes(16).toString("hex");
    sessions.set(sessionToken, user.username);
    reply.setCookie(SESSION_COOKIE, sessionToken, { path: "/", httpOnly: true, sameSite: "lax" });
    if (b.remember === "1") {
      const token = rememberTokenFor(user.username);
      issuedRememberTokens.add(token);
      reply.setCookie(REMEMBER_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
    }
    return reply.redirect("/");
  });

  // --- The vulnerable handler --------------------------------------------------
  app.get("/", async (req, reply) => {
    const sessionToken = parseCookie(req.headers.cookie, SESSION_COOKIE);
    let user = sessionToken ? sessions.get(sessionToken) : undefined;

    if (!user) {
      const remember = parseCookie(req.headers.cookie, REMEMBER_COOKIE);
      if (remember) {
        const matched = USERS.find((u) => rememberTokenFor(u.username) === remember); // recomputed, not looked up by stored secret
        if (matched) {
          user = matched.username;
          if (!issuedRememberTokens.has(remember)) {
            await reportSolve(ctx, `a remember-me cookie this server never issued (computed for username "${matched.username}") granted an authenticated session`);
          }
          issuedRememberTokens.add(remember); // now "seen"
          const newSession = randomBytes(16).toString("hex");
          sessions.set(newSession, user);
          reply.setCookie(SESSION_COOKIE, newSession, { path: "/", httpOnly: true, sameSite: "lax" });
        }
      }
    }

    reply.type("text/html");
    if (!user) return reply.redirect("/login");
    return shell("Pantry", `<div class="panel"><h1>Welcome, ${escapeHtml(user)}</h1><p class="muted">Your pantry is empty.</p></div>`, user);
  });

  app.get("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.redirect("/login");
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[pantrypal] fatal error:", err);
  process.exit(1);
});
