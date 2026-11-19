/**
 * Dispatchly — Delivery Lookup (a verbose error message leaks a service token)
 *
 * Looking up a delivery calls an internal routing service through a thin
 * client. When that call fails, the error handler returns the raw exception
 * message "to help debugging" — which, for this client, includes the
 * Authorization header it was about to send. A malformed tracking number is
 * all it takes to make the call fail before anything is sent. Recorded only
 * when the leaked token is used to call the internal routing service directly.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Dispatchly";
const ROUTING_TOKEN = `rt_${seededSecret(ctx, "routing-service-token", 24)}`;

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const sessions = makeSessions<{ user: string }>(ctx, "dispatchly_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#ff5555",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/track", label: "Track a delivery" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

/** The internal routing client: builds the request, and on failure its error carries everything it was about to send. */
function buildRoutingRequest(trackingNumber: string) {
  if (!/^[A-Z]{2}\d{9}$/.test(trackingNumber)) {
    throw new Error(`RoutingClient: failed to build request for "${trackingNumber}" — GET https://routing.internal.dispatchly.example/v1/lookup?tn=${encodeURIComponent(trackingNumber)} Authorization: Bearer ${ROUTING_TOKEN}`);
  }
  return { trackingNumber };
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/track", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/track" : "/login"));

  app.get("/track", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Track a delivery", `<div class="panel"><h1>Track a delivery</h1>
      <p><input id="tn" placeholder="Tracking number, e.g. AB123456789" /> <button onclick="go()">Track</button></p><pre id="out" class="muted"></pre></div>
      <script>async function go(){ const r = await fetch("/api/track?tn=" + encodeURIComponent(document.getElementById("tn").value)); document.getElementById("out").textContent = JSON.stringify(await r.json(), null, 2); }</script>`, "Alice Chen");
  });

  app.get("/api/track", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    const tn = String((req.query as { tn?: string }).tn ?? "");
    try {
      buildRoutingRequest(tn);
      return { trackingNumber: tn, status: "in_transit", eta: "2 days" };
    } catch (e) {
      // "helps debugging" — but the exception message is the request that was about to be sent, token included.
      return reply.code(502).send({ error: "routing lookup failed", detail: (e as Error).message });
    }
  });

  app.get("/api/internal/routing/lookup", async (req, reply) => {
    const auth = String(req.headers.authorization ?? "");
    if (auth !== `Bearer ${ROUTING_TOKEN}`) return reply.code(401).send({ error: "invalid or missing bearer token" });
    await reportSolve(ctx, `the internal routing service token was read from a verbose error message and used to call /api/internal/routing/lookup directly`);
    return { depot: "SYNTHETIC-DEPOT-14", route: "R-882" };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[dispatchly] fatal error:", err);
  process.exit(1);
});
