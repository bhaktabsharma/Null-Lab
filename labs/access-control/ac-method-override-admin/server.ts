/**
 * Helpdesk — Customer Records (administrative action reachable via method override)
 *
 * Deleting a customer is an administrator action, guarded by a hook that fires
 * on the DELETE method. The same app supports `X-HTTP-Method-Override` on POST
 * "for older clients that can't send DELETE" — and the override is applied
 * INSIDE the handler, after the guard has already looked at the real method
 * (POST). Recorded only when a customer record is actually deleted by a
 * signed-in user who is not an administrator.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Helpdesk";

type Role = "agent" | "admin";
interface User {
  username: string;
  password: string;
  displayName: string;
  role: Role;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", role: "agent" },
  { username: "tess", password: "Admin-Help!21", displayName: "Tess Duarte", role: "admin" },
];
interface Customer {
  id: number;
  name: string;
  plan: string;
  note: string;
}
const customers: Customer[] = [
  { id: 1, name: "Orchid Bakery", plan: "Pro", note: "Prefers email contact." },
  { id: 2, name: "Basalt Logistics", plan: "Enterprise", note: "Renewal due in March." },
  { id: 3, name: "Fjord Analytics", plan: "Pro", note: "Asked about SSO." },
  { id: 4, name: "Marlow & Sons", plan: "Starter", note: "Trial converted last week." },
];

const sessions = makeSessions<{ user: string }>(ctx, "helpdesk_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#f1fa8c",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/customers", label: "Customers" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const me = await (await fetch("/api/me")).json();
  const data = await (await fetch("/api/customers")).json();
  document.getElementById("rows").innerHTML = data.customers.map(function (c) {
    const del = me.role === "admin" ? ' <button onclick="del(' + c.id + ')">Delete</button>' : "";
    return "<tr><td>" + esc(c.id) + "</td><td>" + esc(c.name) + "</td><td>" + esc(c.plan) + "</td><td>" + esc(c.note) + '</td><td><button onclick="note(' + c.id + ')">Add note</button>' + del + "</td></tr>";
  }).join("");
}
async function note(id) {
  const text = prompt("Note?");
  if (text === null) return;
  await fetch("/api/customers/" + id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: text }) });
  load();
}
async function del(id) {
  await fetch("/api/customers/" + id, { method: "DELETE" });
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/customers", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(viewer(req) ? "/customers" : "/login"));

  app.get("/customers", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Customers",
      `<div class="panel"><h1>Customer records</h1>
        <table><tr><th>Id</th><th>Name</th><th>Plan</th><th>Note</th><th></th></tr><tbody id="rows"></tbody></table></div>
      <script>${PAGE_SCRIPT}</script>`,
      u.displayName,
    );
  });

  // The guard: keyed on the actual HTTP method of the request.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "DELETE" && req.url.startsWith("/api/customers/")) {
      const u = viewer(req);
      if (!u) return reply.code(401).send({ error: "login required" });
      if (u.role !== "admin") return reply.code(403).send({ error: "administrators only" });
    }
  });

  app.get("/api/me", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { username: u.username, role: u.role };
  });
  app.get("/api/customers", async (req, reply) => {
    if (!viewer(req)) return reply.code(401).send({ error: "login required" });
    return { customers };
  });

  const remove = (id: number): boolean => {
    const i = customers.findIndex((c) => c.id === id);
    if (i < 0) return false;
    customers.splice(i, 1);
    return true;
  };

  app.delete("/api/customers/:id", async (req, reply) => {
    // Reached only after the guard hook above has verified an administrator.
    if (!remove(Number((req.params as { id: string }).id))) return reply.code(404).send({ error: "no such customer" });
    return { deleted: true };
  });

  // --- Update endpoint, with "legacy client" method override applied in the handler. ---
  app.post("/api/customers/:id", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const id = Number((req.params as { id: string }).id);
    const c = customers.find((x) => x.id === id);
    if (!c) return reply.code(404).send({ error: "no such customer" });
    const override = String(req.headers["x-http-method-override"] ?? "").toUpperCase();
    if (override === "DELETE") {
      remove(id);
      if (u.role !== "admin") {
        await reportSolve(ctx, `"${u.username}" (role "${u.role}") deleted customer ${id} ("${c.name}") by sending POST with X-HTTP-Method-Override: DELETE`);
      }
      return { deleted: true };
    }
    const note = ((req.body ?? {}) as { note?: unknown }).note;
    if (typeof note !== "string" || note.length > 200) return reply.code(400).send({ error: "note must be a string up to 200 characters" });
    c.note = note;
    return { customer: c };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[helpdesk] fatal error:", err);
  process.exit(1);
});
