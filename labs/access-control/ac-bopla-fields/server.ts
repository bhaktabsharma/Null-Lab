/**
 * PeopleHub — Sparse Fieldsets (broken object property level authorization)
 *
 * The default response strips salary/performanceRating for non-HR viewers.
 * The documented `fields` parameter builds the response by projecting
 * straight from the raw record, so the strip never runs. Recorded only when a
 * non-HR viewer's response actually contains a restricted property.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  makeSessions,
  registerPasswordLogin,
  escapeHtml,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "PeopleHub";

interface User {
  username: string;
  password: string;
  displayName: string;
  role: "employee" | "hr";
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", role: "employee" },
  { username: "hana", password: "Adm1n-HR!31", displayName: "Hana Ito", role: "hr" },
];

type Employee = Record<string, string | number>;
const EMPLOYEES: Employee[] = [
  { id: 1, name: "Alice Chen", title: "Support Specialist", department: "Support", salary: 52000, performanceRating: "Meets" },
  { id: 2, name: "Marcus Webb", title: "Staff Engineer", department: "Engineering", salary: 148000, performanceRating: "Exceeds" },
  { id: 3, name: "Priya Nair", title: "Controller", department: "Finance", salary: 117000, performanceRating: "Exceeds" },
  { id: 4, name: "Tomás Rivera", title: "Ops Manager", department: "Operations", salary: 96000, performanceRating: "Needs improvement" },
  { id: 5, name: "Hana Ito", title: "HR Director", department: "People", salary: 131000, performanceRating: "Exceeds" },
];
const RESTRICTED_FIELDS = ["salary", "performanceRating"];

const sessions = makeSessions<{ user: string }>(ctx, "ph2_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#9be564",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/", label: "Directory" }, { href: "/api/docs", label: "API reference" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

/** Shapes one record for a viewer. */
function shape(emp: Employee, viewer: User, fields: string | undefined): Employee {
  if (fields !== undefined) {
    // VULNERABLE: sparse fieldsets are projected from the raw record, skipping the role filter below.
    const out: Employee = {};
    for (const f of fields.split(",").map((x) => x.trim())) {
      const v = emp[f];
      if (v !== undefined) out[f] = v;
    }
    return out;
  }
  const out: Employee = {};
  for (const [k, v] of Object.entries(emp)) {
    if (RESTRICTED_FIELDS.includes(k) && viewer.role !== "hr") continue;
    out[k] = v;
  }
  return out;
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
    reply.type("text/html");
    const rows = EMPLOYEES.map((e) => shape(e, u, undefined))
      .map((e) => `<tr><td>${e.id}</td><td>${escapeHtml(String(e.name))}</td><td>${escapeHtml(String(e.title))}</td><td>${escapeHtml(String(e.department))}</td></tr>`)
      .join("");
    return shell(
      "Directory",
      `<div class="panel"><h1>Company directory</h1><table><tr><th>#</th><th>Name</th><th>Title</th><th>Department</th></tr>${rows}</table></div>`,
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
          <tr><td>GET</td><td>/api/employees</td><td>List employees.</td></tr>
          <tr><td>GET</td><td>/api/employees/:id</td><td>One employee.</td></tr>
        </table>
        <p class="muted">Both accept <code>?fields=a,b,c</code> — a comma-separated list of properties to return (sparse fieldsets), to keep payloads small.</p></div>`,
      viewer(req)?.displayName,
    );
  });

  const respond = async (req: Parameters<typeof sessions.read>[0], u: User, records: Employee[]) => {
    const fields = (req.query as { fields?: string } | undefined)?.fields;
    const shaped = records.map((e) => shape(e, u, fields));
    const leaked = RESTRICTED_FIELDS.filter((f) => shaped.some((s) => f in s));
    if (u.role !== "hr" && leaked.length > 0) {
      await reportSolve(ctx, `session user "${u.username}" (role "${u.role}") received restricted propert${leaked.length > 1 ? "ies" : "y"} ${leaked.join(", ")} via ?fields=${fields ?? ""}`);
    }
    return shaped;
  };

  app.get("/api/employees", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { employees: await respond(req, u, EMPLOYEES) };
  });

  app.get("/api/employees/:id", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const emp = EMPLOYEES.find((e) => e.id === Number((req.params as { id: string }).id));
    if (!emp) return reply.code(404).send({ error: "no such employee" });
    const [shaped] = await respond(req, u, [emp]);
    return { employee: shaped };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[peoplehub] fatal error:", err);
  process.exit(1);
});
