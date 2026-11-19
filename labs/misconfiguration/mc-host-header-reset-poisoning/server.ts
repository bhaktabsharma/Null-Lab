/**
 * MailFlow — Reset Link Host (password-reset poisoning via Host header)
 *
 * POST /forgot-password builds the reset link as
 * `https://${req.headers.host}/reset-password/${token}` — trusting the
 * incoming Host header instead of a fixed, server-configured domain. A mock
 * email sink (in-memory, never a real mail server) stands in for the
 * outbound email, exactly as a learner would see it land in an inbox.
 * Recorded only when an actual sent email's link host is not this
 * application's real, configured domain.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml } from "@nulllab/lab-sdk";
import { randomBytes } from "node:crypto";

const ctx = loadLabContext();
const APP = "MailFlow";
// The application's real, intended access point — in this lab, the exact
// host the instance actually listens on. A genuine, non-forged request
// (a learner's own browser hitting this target normally) always carries
// this as its Host header; anything else is a forged value.
const REAL_DOMAIN = `127.0.0.1:${ctx.port}`;
const USERS = [{ username: "alice", email: "alice@example.test" }];
const outbox: { to: string; subject: string; body: string; linkHost: string }[] = [];

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#6bd8a8", navLinks: [{ href: "/", label: "Forgot password" }, { href: "/mail/outbox", label: "Mail outbox" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Forgot password",
      `<div class="panel" style="max-width:420px;margin:3rem auto;"><h1>Forgot password</h1>
        <form method="post" action="/forgot-password"><p><input type="text" name="username" placeholder="Username" /></p><button type="submit">Send reset link</button></form></div>`,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.post("/forgot-password", async (req, reply) => {
    const username = String((req.body as { username?: unknown } | null)?.username ?? "");
    const user = USERS.find((u) => u.username === username);
    reply.type("text/html");
    if (user) {
      const token = randomBytes(8).toString("hex");
      // VULNERABLE: the host comes straight from the request, not a fixed setting.
      const host = String(req.headers.host ?? REAL_DOMAIN);
      const link = `https://${host}/reset-password/${token}`;
      outbox.push({ to: user.email, subject: "Reset your MailFlow password", body: `Click to reset your password: ${link}`, linkHost: host });
      if (outbox.length > 50) outbox.shift();

      if (host !== REAL_DOMAIN) {
        await reportSolve(ctx, `a password-reset email was sent to "${user.email}" with a reset link pointing at host "${host}", not the application's real domain "${REAL_DOMAIN}"`);
      }
    }
    return shell("Check your inbox", `<div class="panel"><p>If that account exists, a reset email was sent. <a class="link" href="/mail/outbox">View outbox</a></p></div>`);
  });

  app.get("/mail/outbox", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Mail outbox",
      `<div class="panel"><h1>Mail outbox</h1><p class="muted">A local mock inbox — never a real mail server.</p>
        ${outbox
          .slice(-10)
          .reverse()
          .map((m) => `<div class="panel" style="background:#0b0e13;margin-bottom:0.5rem;"><p><strong>To:</strong> ${escapeHtml(m.to)}</p><p><strong>Subject:</strong> ${escapeHtml(m.subject)}</p><p>${escapeHtml(m.body)}</p></div>`)
          .join("")}</div>`,
    );
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[mailflow] fatal error:", err);
  process.exit(1);
});
