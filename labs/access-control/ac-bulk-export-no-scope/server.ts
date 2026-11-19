/**
 * PeopleHub — Export Everyone (bulk-export BOLA)
 *
 * GET /api/directory correctly scopes results to the caller's own
 * organization. GET /api/export/employees.csv — a separate endpoint behind
 * the page's "Export CSV" button — iterates the ENTIRE employee table with
 * no organization filter of any kind. Recorded only when a real export
 * actually contains a row from an organization other than the caller's own.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, makeSessions, registerPasswordLogin, renderShell, escapeHtml } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "PeopleHub";
interface User { username: string; password: string; displayName: string; org: string; }
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", org: "Acme" },
  { username: "gina", password: "Gl0bex-Staff!4", displayName: "Gina Torres", org: "Globex" },
];
const EMPLOYEES = [
  { org: "Acme", name: "Alice Chen", title: "Support" },
  { org: "Acme", name: "Ben Hollis", title: "Engineer" },
  { org: "Globex", name: "Gina Torres", title: "Sales" },
  { org: "Globex", name: "Marta Lund", title: "Legal Counsel — handling the Q4 acquisition, confidential" },
];
const sessions = makeSessions<{ user: string }>(ctx, "ph4_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#9be564", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    const rows = EMPLOYEES.filter((e) => e.org === u.org);
    reply.type("text/html");
    return shell(
      "Directory",
      `<div class="panel"><h1>${escapeHtml(u.org)} directory</h1><table><tr><th>Name</th><th>Title</th></tr>${rows.map((e) => `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.title)}</td></tr>`).join("")}</table>
        <p><a class="link" href="/api/export/employees.csv">Export CSV</a></p></div>`,
      u.displayName,
    );
  });

  app.get("/api/directory", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { employees: EMPLOYEES.filter((e) => e.org === u.org) };
  });

  // --- The vulnerable handler: no organization scoping at all. ----------------
  app.get("/api/export/employees.csv", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const rows = EMPLOYEES; // VULNERABLE: every organization, unfiltered.
    const csv = ["org,name,title", ...rows.map((e) => `${e.org},${e.name},${e.title}`)].join("\n");

    const foreign = rows.filter((e) => e.org !== u.org);
    if (foreign.length > 0) {
      await reportSolve(ctx, `the CSV export for "${u.username}" (org "${u.org}") included ${foreign.length} row(s) from other organization(s): ${[...new Set(foreign.map((e) => e.org))].join(", ")}`);
    }
    reply.header("content-type", "text/csv");
    return csv;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[peoplehub-export] fatal error:", err);
  process.exit(1);
});
