/**
 * Panelio — Admin Dashboard (source map exposure leaks an internal API token)
 *
 * The bundler was told to ship source maps "for better crash reports" and nobody
 * turned it off for production. The minified bundle calls an internal reporting
 * API with a bearer token baked in at build time; the source map, served
 * alongside the bundle, reconstructs the original source and the token in full.
 * Recorded only when that exact token is used to call the internal endpoint.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Panelio";
const TOKEN = `pnl_live_${seededSecret(ctx, "reporting-token", 20)}`;

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const sessions = makeSessions<{ user: string }>(ctx, "panelio_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#8be9fd",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/dashboard", label: "Dashboard" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const BUNDLE_SRC = `
"use strict";
function initReportingClient() {
  var reportingClient = new InternalReportingClient({
    baseUrl: "/api/internal/reports",
    // TODO(build): move this to the server before GA — tracked in PANEL-4417
    authToken: "${TOKEN}",
  });
  window.__panelioReporting = reportingClient;
  return reportingClient;
}
function renderDashboard(stats) {
  document.getElementById("stats").textContent = "Active sessions: " + stats.activeSessions;
}
async function loadDashboard() {
  var stats = await (await fetch("/api/dashboard-stats")).json();
  renderDashboard(stats);
}
initReportingClient();
loadDashboard();
`;
// A real bundler's minifier output: same behavior, names mangled, no comments — the source map undoes exactly this.
const BUNDLE_MIN = `"use strict";function a(){var b=new InternalReportingClient({baseUrl:"/api/internal/reports",authToken:"${TOKEN}"});return window.__panelioReporting=b,b}function c(d){document.getElementById("stats").textContent="Active sessions: "+d.activeSessions}async function e(){var f=await(await fetch("/api/dashboard-stats")).json();c(f)}a();e();`;

function toVLQ(nums: number[]): string {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (const n of nums) {
    let v = n < 0 ? (-n << 1) | 1 : n << 1;
    do {
      let digit = v & 0x1f;
      v >>>= 5;
      if (v > 0) digit |= 0x20;
      out += CHARS[digit];
    } while (v > 0);
  }
  return out;
}
// A minimal but real source map: enough segments to round-trip every line back to the original.
function buildSourceMap(): string {
  const minLines = BUNDLE_MIN.split("\n").length;
  const segments: string[] = [];
  for (let i = 0; i < minLines; i++) segments.push(toVLQ([0, 0, i, 0]));
  return JSON.stringify({ version: 3, file: "app.min.js", sources: ["app.js"], sourcesContent: [BUNDLE_SRC], names: [], mappings: segments.join(";") });
}
const SOURCE_MAP = buildSourceMap();

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/dashboard", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/dashboard" : "/login"));

  app.get("/dashboard", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Dashboard", `<div class="panel"><h1>Operations dashboard</h1><p id="stats" class="muted">Loading…</p></div>
      <script src="/assets/app.min.js"></script>`, "Alice Chen");
  });

  app.get("/api/dashboard-stats", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    return { activeSessions: 42 };
  });

  // The bundle and its map are public static assets, same as any production build.
  app.get("/assets/app.min.js", async (_req, reply) => {
    reply.header("sourcemappingurl", "/assets/app.min.js.map").type("application/javascript");
    return BUNDLE_MIN;
  });
  app.get("/assets/app.min.js.map", async (_req, reply) => {
    reply.type("application/json");
    return SOURCE_MAP;
  });

  app.get("/api/internal/reports", async (req, reply) => {
    const auth = String(req.headers.authorization ?? "");
    if (auth !== `Bearer ${TOKEN}`) return reply.code(401).send({ error: "invalid or missing bearer token" });
    await reportSolve(ctx, `the internal reporting token was extracted from the production source map and used to call /api/internal/reports directly`);
    return { reports: [{ id: "rep-1", summary: "SYNTHETIC weekly uptime report — 99.98%" }] };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[panelio] fatal error:", err);
  process.exit(1);
});
