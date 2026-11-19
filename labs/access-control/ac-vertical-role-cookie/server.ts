/**
 * Brightpath CRM — Role in a Cookie (vertical privilege escalation)
 *
 * After login the server issues a signed session cookie (identity) AND a
 * plain `role` cookie, then trusts the plain cookie for authorization. The
 * solve is recorded only when the admin page is actually served to a session
 * whose REAL role (from the server's own user table) is not admin.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  escapeHtml,
  makeSessions,
  readPlainCookie,
  scopedCookieName,
  registerPasswordLogin,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Brightpath CRM";

interface User {
  username: string;
  password: string;
  displayName: string;
  role: "user" | "admin";
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", role: "user" },
  { username: "ops", password: "Adm1n-CRM!77", displayName: "Olivia Park", role: "admin" },
];
const CUSTOMERS = [
  { id: 1, company: "Northwind Foods", contact: "j.lee@northwind.example", arr: "84,000" },
  { id: 2, company: "Contoso Logistics", contact: "m.ortiz@contoso.example", arr: "126,500" },
  { id: 3, company: "Tailspin Air", contact: "s.khan@tailspin.example", arr: "212,000" },
];

const sessions = makeSessions<{ user: string }>(ctx, "bp_session");
const ROLE_COOKIE = scopedCookieName(ctx, "role");

function shell(title: string, body: string, user?: string, role?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#f2b84b",
    currentUserLabel: user ?? null,
    navLinks: user
      ? [
          { href: "/dashboard", label: "Dashboard" },
          ...(role === "admin" ? [{ href: "/admin/customers", label: "Admin" }] : []),
          { href: "/logout", label: "Log out" },
        ]
      : [{ href: "/login", label: "Log in" }],
  });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  registerPasswordLogin(app, {
    users: USERS,
    sessions,
    shell,
    appName: APP,
    home: "/dashboard",
    demoLine: "Demo account: <strong>alice</strong> / practice123",
    // The mistake: authorization state handed to the client in a plain cookie.
    onLogin: (reply, user) => {
      reply.setCookie(ROLE_COOKIE, user.role, { path: "/", sameSite: "lax" });
    },
  });

  app.get("/", async (req, reply) => reply.redirect(sessions.read(req) ? "/dashboard" : "/login"));

  app.get("/dashboard", async (req, reply) => {
    const s = sessions.read(req);
    if (!s) return reply.redirect("/login");
    const user = USERS.find((u) => u.username === s.user)!;
    const role = readPlainCookie(ctx, req, "role");
    reply.type("text/html");
    return shell(
      "Dashboard",
      `<div class="panel">
        <h1>Welcome, ${escapeHtml(user.displayName)}</h1>
        <p class="muted">You have <strong>${CUSTOMERS.length}</strong> accounts assigned to your territory.</p>
        <p>Your role: <span class="pill">${escapeHtml(role ?? "unknown")}</span></p>
      </div>`,
      user.displayName,
      role,
    );
  });

  // --- The vulnerable handler -------------------------------------------------
  app.get("/admin/customers", async (req, reply) => {
    const s = sessions.read(req);
    if (!s) return reply.redirect("/login");
    const user = USERS.find((u) => u.username === s.user)!;
    const claimedRole = readPlainCookie(ctx, req, "role");

    // VULNERABLE: authorization uses the client-supplied cookie.
    if (claimedRole !== "admin") {
      reply.code(403);
      reply.type("text/html");
      return shell("Forbidden", `<div class="panel"><h1>403 — Administrators only</h1></div>`, user.displayName, claimedRole);
    }

    if (user.role !== "admin") {
      await reportSolve(
        ctx,
        `session user "${user.username}" (real role "${user.role}") was served GET /admin/customers because the request's role cookie said "${claimedRole}"`,
      );
    }
    reply.type("text/html");
    return shell(
      "Customer export",
      `<div class="panel">
        <h1>Customer export (admin)</h1>
        <table>
          <tr><th>#</th><th>Company</th><th>Contact</th><th>ARR (USD)</th></tr>
          ${CUSTOMERS.map((c) => `<tr><td>${c.id}</td><td>${escapeHtml(c.company)}</td><td>${escapeHtml(c.contact)}</td><td>${c.arr}</td></tr>`).join("")}
        </table>
      </div>`,
      user.displayName,
      claimedRole,
    );
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[brightpath-crm] fatal error:", err);
  process.exit(1);
});
