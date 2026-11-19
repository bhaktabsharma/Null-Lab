/**
 * VaultKey — Almost Two Factors (MFA step-skip)
 *
 * POST /login mints a session as soon as the password is correct — which is
 * reasonable, since the server has to remember who is mid-login — but
 * GET /account only checks that a session EXISTS, never that its
 * `mfaVerified` flag was actually set by a correct one-time code. Recorded
 * only when /account is served for a session whose own record shows
 * mfaVerified is still false.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, seededSecret } from "@nulllab/lab-sdk";
import { randomBytes } from "node:crypto";

const ctx = loadLabContext();
const APP = "VaultKey";
const USER = { username: "alice", password: "practice123" };
const OTP = seededSecret(ctx, "otp", 6, "0123456789");
const COOKIE = `vk_session_${ctx.port}`;

interface Session { user: string; mfaVerified: boolean; }
const sessions = new Map<string, Session>();
function parseCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
}

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#e0c15c", navLinks: [{ href: "/login", label: "Sign in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => reply.redirect("/login"));

  app.get("/login", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Sign in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Sign in to VaultKey</h1>
        <form method="post" action="/login"><p><input type="text" name="username" placeholder="Username" /></p>
        <p><input type="password" name="password" placeholder="Password" /></p><button type="submit">Sign in</button></form>
        <p class="muted">Demo: <strong>alice</strong> / practice123</p></div>`,
    );
  });

  app.post("/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    reply.type("text/html");
    if (b.username !== USER.username || b.password !== USER.password) {
      reply.code(401);
      return shell("Sign in", `<div class="panel"><p style="color:#e07a7a;">Incorrect username or password.</p></div>`);
    }
    const token = randomBytes(16).toString("hex");
    sessions.set(token, { user: USER.username, mfaVerified: false });
    reply.setCookie(COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax" });
    return reply.redirect("/verify-code");
  });

  app.get("/verify-code", async (req, reply) => {
    const s = sessions.get(parseCookie(req.headers.cookie, COOKIE) ?? "");
    if (!s) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Enter code",
      `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Enter your 6-digit code</h1>
        <form method="post" action="/verify-code"><p><input type="text" name="code" inputmode="numeric" maxlength="6" /></p><button type="submit">Verify</button></form></div>`,
    );
  });

  app.post("/verify-code", async (req, reply) => {
    const token = parseCookie(req.headers.cookie, COOKIE);
    const s = token ? sessions.get(token) : undefined;
    reply.type("text/html");
    if (!s) return reply.redirect("/login");
    const code = String((req.body as { code?: unknown } | null)?.code ?? "");
    if (code !== OTP) {
      reply.code(401);
      return shell("Enter code", `<div class="panel"><p style="color:#e07a7a;">Incorrect code.</p></div>`);
    }
    s.mfaVerified = true;
    return reply.redirect("/account");
  });

  // --- The vulnerable handler: checks session presence only. ------------------
  app.get("/account", async (req, reply) => {
    const token = parseCookie(req.headers.cookie, COOKIE);
    const s = token ? sessions.get(token) : undefined;
    if (!s) return reply.redirect("/login");
    reply.type("text/html");
    if (!s.mfaVerified) {
      await reportSolve(ctx, `GET /account was served for a session whose mfaVerified flag is still false — the one-time code step was never completed`);
    }
    return shell("Account", `<div class="panel"><h1>Account</h1><p class="muted">Signed in as ${USER.username}.</p></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[vaultkey] fatal error:", err);
  process.exit(1);
});
