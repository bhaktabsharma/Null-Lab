/**
 * LedgerBase — Reset Ticket # (predictable password-reset tokens)
 *
 * Reset tokens are a plain, in-memory incrementing counter rather than a
 * random value, so one user's token tells you a great deal about everyone
 * else's. An admin reset was already requested just before this instance
 * started (as real "someone requested a reset recently" traffic would look),
 * so a learner who requests their OWN reset can infer a nearby in-range
 * token. Recorded only when the ADMIN account's password is actually reset
 * using a token the attacker's own account was never issued.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "LedgerBase";
interface User { username: string; password: string; displayName: string; }
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "admin", password: "R9#mK2!vQzL8", displayName: "Site Administrator" },
];
const sessions = makeSessions<{ user: string }>(ctx, "lb_session");

let nextToken = 1000;
const tokenOwner = new Map<number, string>();
function issueToken(username: string): number {
  const t = nextToken++;
  tokenOwner.set(t, username);
  return t;
}
// Simulates a recent, unrelated admin reset request that happened just before this instance came up.
const adminTokenIssuedEarlier = issueToken("admin");
void adminTokenIssuedEarlier;

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#53c6e0", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/account", label: "Account" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }, { href: "/forgot-password", label: "Forgot password" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/account", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/", async (req, reply) => reply.redirect(sessions.read(req) ? "/account" : "/login"));

  app.get("/account", async (req, reply) => {
    const s = sessions.read(req);
    if (!s) return reply.redirect("/login");
    const u = USERS.find((x) => x.username === s.user)!;
    reply.type("text/html");
    return shell("Account", `<div class="panel"><h1>Welcome, ${escapeHtml(u.displayName)}</h1></div>`, u.displayName);
  });

  app.get("/forgot-password", async (_req, reply) => {
    reply.type("text/html");
    return shell("Forgot password", `<div class="panel" style="max-width:420px;margin:3rem auto;"><h1>Forgot password</h1>
      <form method="post" action="/forgot-password"><p><input type="text" name="username" placeholder="Your username" /></p><button type="submit">Send reset link</button></form></div>`);
  });

  app.post("/forgot-password", async (req, reply) => {
    const username = String((req.body as { username?: unknown } | null)?.username ?? "");
    const user = USERS.find((u) => u.username === username);
    reply.type("text/html");
    // VULNERABLE: the token is a plain sequential counter.
    const token = user ? issueToken(username) : undefined;
    return shell(
      "Reset link sent",
      `<div class="panel"><h1>Check your inbox</h1><p class="muted">If that account exists, a reset link was sent.</p>
        ${token !== undefined ? `<p>(Lab convenience — normally emailed) Your reset link: <a class="link" href="/reset-password/${token}">/reset-password/${token}</a></p>` : ""}</div>`,
    );
  });

  app.get("/reset-password/:token", async (req, reply) => {
    const token = Number((req.params as { token: string }).token);
    const owner = tokenOwner.get(token);
    reply.type("text/html");
    if (!owner) {
      reply.code(404);
      return shell("Invalid link", `<div class="panel"><p>This reset link is invalid or has already been used.</p></div>`);
    }
    return shell(
      "Set a new password",
      `<div class="panel" style="max-width:420px;margin:3rem auto;"><h1>Set a new password</h1>
        <form method="post" action="/reset-password/${token}"><p><input type="password" name="password" placeholder="New password" /></p><button type="submit">Set password</button></form></div>`,
    );
  });

  app.post("/reset-password/:token", async (req, reply) => {
    const token = Number((req.params as { token: string }).token);
    const owner = tokenOwner.get(token);
    reply.type("text/html");
    if (!owner) {
      reply.code(404);
      return shell("Invalid link", `<div class="panel"><p>This reset link is invalid or has already been used.</p></div>`);
    }
    const password = String((req.body as { password?: unknown } | null)?.password ?? "");
    if (password.length < 8 || password.length > 100) {
      reply.code(400);
      return shell("Weak password", `<div class="panel"><p>Password must be at least 8 characters.</p></div>`);
    }
    const user = USERS.find((u) => u.username === owner)!;
    user.password = password;
    tokenOwner.delete(token); // single-use, which is correct — the flaw is the token's predictability, not its reuse
    if (owner === "admin") {
      await reportSolve(ctx, `the admin account's password was reset via token ${token}, which was never issued to the attacker's own account`);
    }
    return shell("Password updated", `<div class="panel"><p>Your password has been updated. <a class="link" href="/login">Sign in</a></p></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[ledgerbase] fatal error:", err);
  process.exit(1);
});
