/**
 * Notifyr — Push Notification Service (a debug endpoint left reachable in production)
 *
 * The real send-notification endpoint requires a valid HMAC signature over the
 * payload. A `/debug/*` namespace was added for local testing — a health probe
 * and, critically, an endpoint that echoes back the server's current signing
 * secret "to make local testing easier" — and NODE_ENV never gets checked
 * before mounting it. Recorded only when a notification is actually sent using
 * a signature computed with the secret read from the debug endpoint.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Notifyr";
const SIGNING_SECRET = seededSecret(ctx, "hmac-signing-secret", 28);
const sign = (payload: string) => createHmac("sha256", SIGNING_SECRET).update(payload).digest("hex");

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const sent: { to: string; message: string }[] = [];
const sessions = makeSessions<{ user: string }>(ctx, "notifyr_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#ffb86c",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/console", label: "Console" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/console", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/console" : "/login"));

  app.get("/console", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Console", `<div class="panel"><h1>Notification console</h1>
      <p class="muted">Sending requires a request signed with this service's HMAC secret. That secret is never shown here.</p>
      <h2>Sent</h2><ul id="log">${sent.map((s) => `<li>${s.to}: ${s.message}</li>`).join("") || "<li class=muted>Nothing sent yet.</li>"}</ul></div>`, "Alice Chen");
  });

  // Added for local development and never gated behind an environment check.
  app.get("/debug/health", async () => ({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) }));
  app.get("/debug/echo", async (req) => ({ echo: (req.query as { msg?: string }).msg ?? null }));
  app.get("/debug/signing-secret", async () => ({ note: "local-testing helper — do not expose in production", signingSecret: SIGNING_SECRET }));

  app.post("/api/notifications/send", async (req, reply) => {
    const b = (req.body ?? {}) as { to?: unknown; message?: unknown; signature?: unknown };
    if (typeof b.to !== "string" || typeof b.message !== "string" || b.message.length === 0 || b.message.length > 300) {
      return reply.code(400).send({ error: "to and message are required, message up to 300 characters" });
    }
    const payload = JSON.stringify({ to: b.to, message: b.message });
    const expected = Buffer.from(sign(payload), "hex");
    const given = Buffer.from(String(b.signature ?? ""), "hex");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return reply.code(401).send({ error: "invalid or missing signature" });
    sent.push({ to: b.to, message: b.message });
    await reportSolve(ctx, `a notification to "${b.to}" was sent with a valid signature computed using the signing secret read from /debug/signing-secret`);
    return { sent: true };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[notifyr] fatal error:", err);
  process.exit(1);
});
