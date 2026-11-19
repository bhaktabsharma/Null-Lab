/**
 * CloudDesk — Which Tenant Am I? (multi-tenant isolation)
 *
 * A "gateway" convention: every API response carries X-Tenant-Id, and the
 * API also honours that header on REQUESTS to pick the tenant. It should come
 * from the session. Recorded only when data of a tenant other than the
 * signed-in user's own is actually returned.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  makeSessions,
  registerPasswordLogin,
  CLIENT_ESC_JS,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "CloudDesk";

interface User {
  username: string;
  password: string;
  displayName: string;
  tenant: string;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", tenant: "acme" },
  { username: "gina", password: "Gl0bex-Agent!8", displayName: "Gina Torres", tenant: "globex" },
];
const TICKETS = [
  { id: 101, tenant: "acme", subject: "Printer offline on floor 3", body: "Reported by facilities." },
  { id: 102, tenant: "acme", subject: "Request: extra monitor", body: "For the new hire starting Monday." },
  { id: 201, tenant: "globex", subject: "Suspected phishing campaign", body: "Three execs received a fake wire request; CFO already replied." },
  { id: 202, tenant: "globex", subject: "VPN certificate expiring", body: "Renewal blocked on procurement approval — expires Friday." },
];
const TENANTS = new Set(TICKETS.map((t) => t.tenant));

const sessions = makeSessions<{ user: string }>(ctx, "cd_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#5eead4",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/", label: "Tickets" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const HOME_SCRIPT = `
${CLIENT_ESC_JS}
(async function () {
  const r = await (await fetch("/api/tickets")).json();
  document.getElementById("rows").innerHTML = r.tickets.map(function (t) {
    return "<tr><td>#" + t.id + "</td><td>" + esc(t.subject) + "</td></tr>";
  }).join("");
})();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/", demoLine: "Demo account: <strong>alice</strong> (tenant: acme) / practice123" });

  app.get("/", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Tickets",
      `<div class="panel"><h1>Tickets — ${u.tenant}</h1><table><tr><th>#</th><th>Subject</th></tr><tbody id="rows"></tbody></table></div><script>${HOME_SCRIPT}</script>`,
      u.displayName,
    );
  });

  /** Resolves the tenant for this request. VULNERABLE: a client header wins over the session. */
  const resolveTenant = (req: Parameters<typeof sessions.read>[0], u: User): string => {
    const header = req.headers["x-tenant-id"];
    return typeof header === "string" && header.length > 0 ? header : u.tenant;
  };

  app.get("/api/tickets", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const tenant = resolveTenant(req, u);
    reply.header("x-tenant-id", tenant);
    if (!TENANTS.has(tenant)) return reply.code(404).send({ error: "unknown tenant" });
    if (tenant !== u.tenant) {
      await reportSolve(ctx, `session user "${u.username}" (tenant "${u.tenant}") listed tickets of tenant "${tenant}" via X-Tenant-Id`);
    }
    return { tenant, tickets: TICKETS.filter((t) => t.tenant === tenant).map(({ id, subject }) => ({ id, subject })) };
  });

  app.get("/api/tickets/:id", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const tenant = resolveTenant(req, u);
    reply.header("x-tenant-id", tenant);
    const ticket = TICKETS.find((t) => t.id === Number((req.params as { id: string }).id) && t.tenant === tenant);
    if (!ticket) return reply.code(404).send({ error: "no such ticket" });
    if (tenant !== u.tenant) {
      await reportSolve(ctx, `session user "${u.username}" (tenant "${u.tenant}") read ticket ${ticket.id} of tenant "${tenant}" via X-Tenant-Id`);
    }
    return { ticket };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[clouddesk] fatal error:", err);
  process.exit(1);
});
