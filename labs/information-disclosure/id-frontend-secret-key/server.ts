/**
 * Mapstead — Store Locator (API key shipped to the browser, meant to stay server-side)
 *
 * The map widget calls a third-party-style geocoding API. A developer wired the
 * widget straight to that API from the browser and put the key in a small
 * config file served as a static asset "just for local dev" — it shipped to
 * production. The key is meant to be used only from the server's own proxy
 * endpoint, which attaches it itself and never accepts one from the client.
 * Recorded only when the key found in the config file is used directly against
 * the upstream geocoding endpoint.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Mapstead";
const GEOCODE_KEY = seededSecret(ctx, "geocode-api-key", 24);

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const sessions = makeSessions<{ user: string }>(ctx, "mapstead_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#50fa7b",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/locator", label: "Store locator" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const CONFIG_JS = `window.MAPSTEAD_CONFIG = {
  // local-dev config — DO NOT COMMIT (left in by mistake; shipped to this build)
  geocodeApiKey: "${GEOCODE_KEY}",
  geocodeEndpoint: "/api/geocode-upstream"
};`;

// What a normal visitor sees: the widget calls the SERVER'S OWN proxy, no key involved there.
const WIDGET_JS = `
async function lookup() {
  var q = document.getElementById("q").value;
  var r = await fetch("/api/geocode?q=" + encodeURIComponent(q));
  var d = await r.json();
  document.getElementById("result").textContent = r.ok ? (d.lat + ", " + d.lng) : d.error;
}
document.getElementById("go").addEventListener("click", lookup);
`;
let callCount = 0;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/locator", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/locator" : "/login"));

  app.get("/locator", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Store locator", `<div class="panel"><h1>Find a store near you</h1>
      <p><input id="q" placeholder="City or ZIP" /> <button id="go">Search</button></p><p id="result" class="muted"></p></div>
      <script src="/assets/config.js"></script><script src="/assets/widget.js"></script>`, "Alice Chen");
  });

  app.get("/assets/config.js", async (_req, reply) => {
    reply.type("application/javascript");
    return CONFIG_JS;
  });
  app.get("/assets/widget.js", async (_req, reply) => {
    reply.type("application/javascript");
    return WIDGET_JS;
  });

  // The server's own proxy: attaches the key itself, from the server's own config — never from the client.
  app.get("/api/geocode", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    const q = (req.query as { q?: string }).q;
    if (!q) return reply.code(400).send({ error: "q is required" });
    return { lat: 37.77, lng: -122.42, via: "server-proxy" };
  });

  // The upstream API itself: a direct call needs the key, and nothing else about who is calling.
  app.get("/api/geocode-upstream", async (req, reply) => {
    const key = (req.query as { key?: string }).key;
    if (key !== GEOCODE_KEY) return reply.code(401).send({ error: "invalid API key" });
    callCount++;
    await reportSolve(ctx, `the geocoding API key from /assets/config.js was used to call the upstream endpoint directly, bypassing the server's own proxy (call #${callCount})`);
    return { lat: 40.71, lng: -74.0, via: "direct-upstream-call" };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[mapstead] fatal error:", err);
  process.exit(1);
});
