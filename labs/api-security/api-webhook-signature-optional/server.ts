/**
 * Payhook — Subscription Events (webhook signature verification that is optional)
 *
 * Billing events arrive as webhooks and activate Pro access. The handler verifies
 * the signature WHEN ONE IS PRESENT, but a request with no signature header at
 * all skips verification entirely instead of being rejected — a defensive `if`
 * written the wrong way round. Recorded only when a webhook with no signature
 * grants Pro access that a correctly signed event never authorized.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Payhook";
const WEBHOOK_SECRET = seededSecret(ctx, "webhook-secret", 24);
const sign = (body: string) => createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
let plan: "basic" | "pro" = "basic";
const events: { type: string; signed: boolean }[] = [];

const sessions = makeSessions<{ user: string }>(ctx, "payhook_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#8be9fd",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/account", label: "Account" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/account", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/account" : "/login"));

  app.get("/account", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Account", `<div class="panel"><h1>Your plan: ${plan}</h1>
      <p class="muted">This upgrades automatically when the billing provider's webhook confirms payment — the webhook endpoint accepts no input from you directly.</p>
      <h2>Recent billing events</h2><ul>${events.map((e) => `<li>${e.type} (${e.signed ? "signed" : "no signature"})</li>`).join("") || "<li class=muted>None yet.</li>"}</ul></div>`, "Alice Chen");
  });

  // --- The billing provider's webhook endpoint ---------------------------------------
  app.post("/webhooks/billing", async (req, reply) => {
    const raw = JSON.stringify(req.body ?? {});
    const sig = req.headers["x-webhook-signature"];
    if (sig !== undefined) {
      // signature present: verify it properly
      const expected = Buffer.from(sign(raw), "hex");
      const given = Buffer.from(String(sig), "hex");
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return reply.code(401).send({ error: "invalid signature" });
    }
    // signature ABSENT: falls through here with nothing verified at all
    const body = (req.body ?? {}) as { type?: unknown };
    if (typeof body.type !== "string") return reply.code(400).send({ error: "type is required" });
    events.push({ type: body.type, signed: sig !== undefined });
    if (body.type === "subscription.activated") plan = "pro";
    if (body.type === "subscription.cancelled") plan = "basic";
    if (plan === "pro" && sig === undefined) {
      await reportSolve(ctx, `an unsigned "subscription.activated" webhook (no X-Webhook-Signature header at all) granted Pro access`);
    }
    return { received: true };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[payhook] fatal error:", err);
  process.exit(1);
});
