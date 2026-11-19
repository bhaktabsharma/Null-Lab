/**
 * AuditHub — Same Path, Different Verb (authorization on alternate methods)
 *
 * A global hook enforces "admins only" for /api/admin/* — but only for GET.
 * The audit-log route also accepts POST and PUT (to pass a filter), and those
 * skip the hook entirely. Recorded only when the log body is actually served
 * to a non-admin through a non-GET method.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  escapeHtml,
  makeSessions,
  registerPasswordLogin,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "AuditHub";

interface User {
  username: string;
  password: string;
  displayName: string;
  role: "user" | "admin";
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", role: "user" },
  { username: "ada", password: "Adm1n-Audit!9", displayName: "Ada Lindqvist", role: "admin" },
];
const LOG = [
  { id: 1, actor: "ada", action: "rotated service credentials", at: "2026-10-20T09:12:00Z" },
  { id: 2, actor: "ada", action: "disabled account j.martin", at: "2026-10-21T14:03:00Z" },
  { id: 3, actor: "system", action: "nightly backup completed", at: "2026-10-22T02:00:00Z" },
  { id: 4, actor: "ada", action: "exported billing report Q3", at: "2026-10-22T16:41:00Z" },
  { id: 5, actor: "alice", action: "signed in", at: "2026-10-23T08:30:00Z" },
  { id: 6, actor: "ada", action: "changed retention policy to 400 days", at: "2026-10-23T11:55:00Z" },
];

const sessions = makeSessions<{ user: string }>(ctx, "ah_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#ff8f6b",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/", label: "Home" }, { href: "/api/docs", label: "API reference" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  // Everything under /api/* needs a session; /api/docs is the public reference.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/") || path === "/api/docs") return;
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });

    // VULNERABLE: the admin-only rule is attached to GET requests only.
    if (path.startsWith("/api/admin/") && req.method === "GET" && u.role !== "admin") {
      return reply.code(403).send({ error: "administrators only" });
    }
  });

  app.get("/", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Home",
      `<div class="panel"><h1>Welcome, ${escapeHtml(u.displayName)}</h1>
        <p class="muted">AuditHub records administrative activity for your organisation. Standard users can review their own activity; the full log is for administrators.</p>
        <p><a class="link" href="/api/docs">API reference</a></p></div>`,
      u.displayName,
    );
  });

  app.get("/api/docs", async (req, reply) => {
    reply.type("text/html");
    return shell(
      "API reference",
      `<div class="panel"><h1>API reference</h1>
        <table>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
          <tr><td>GET</td><td>/api/me</td><td>The signed-in user.</td></tr>
          <tr><td>GET</td><td>/api/activity</td><td>Your own recent activity.</td></tr>
          <tr><td>GET, POST, PUT</td><td>/api/admin/audit-log</td><td>Administrators only. GET lists entries; POST/PUT accept an optional JSON body <code>{"actor": "..."}</code> to filter.</td></tr>
        </table></div>`,
      viewer(req)?.displayName,
    );
  });

  app.get("/api/me", async (req) => {
    const u = viewer(req)!;
    return { username: u.username, role: u.role };
  });

  app.get("/api/activity", async (req) => {
    const u = viewer(req)!;
    return { entries: LOG.filter((e) => e.actor === u.username) };
  });

  app.route({
    method: ["GET", "POST", "PUT"],
    url: "/api/admin/audit-log",
    handler: async (req) => {
      const u = viewer(req)!;
      const filter = (req.body ?? {}) as { actor?: unknown };
      const entries = typeof filter.actor === "string" ? LOG.filter((e) => e.actor === filter.actor) : LOG;
      if (u.role !== "admin") {
        await reportSolve(ctx, `session user "${u.username}" (role "${u.role}") received the audit log via ${req.method} /api/admin/audit-log`);
      }
      return { entries };
    },
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[audithub] fatal error:", err);
  process.exit(1);
});
