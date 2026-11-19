/**
 * Folio — Import From Another Project (cross-tenant reference in a nested API)
 *
 * Everything under /api/orgs/:org/... checks that you belong to :org, and the
 * project read endpoint also checks that the project belongs to that org. The
 * import action copies another project's notes into one of your own, and its
 * SOURCE project id — taken from the request body — is looked up globally and
 * never compared with the caller's org. Recorded only when notes from a project
 * in a different organization are copied into the caller's organization.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Folio";

interface User {
  username: string;
  password: string;
  displayName: string;
  orgs: string[];
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", orgs: ["northwind"] },
  { username: "dana", password: "Dana-Folio!51", displayName: "Dana Whitfield", orgs: ["contoso"] },
];
interface Project {
  id: string;
  org: string;
  name: string;
  notes: string;
}
const PROJECTS: Project[] = [
  { id: "p-101", org: "northwind", name: "Northwind Onboarding", notes: "SYNTHETIC onboarding checklist — laptop, badge, accounts." },
  { id: "p-102", org: "northwind", name: "Northwind Roadmap", notes: "SYNTHETIC roadmap — Q1: importer, Q2: SSO." },
  { id: "p-201", org: "contoso", name: "Contoso Acquisition Plan", notes: "SYNTHETIC CONFIDENTIAL — target: Fabrikam Ltd, offer ceiling 38M, announce date 3 March." },
  { id: "p-202", org: "contoso", name: "Contoso Q4 Layoffs", notes: "SYNTHETIC CONFIDENTIAL — reduction of 40 roles across support and sales." },
];

const sessions = makeSessions<{ user: string }>(ctx, "folio_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#50fa7b",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/projects", label: "Projects" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
let org = null;
async function load() {
  const me = await (await fetch("/api/me")).json();
  org = me.orgs[0];
  const data = await (await fetch("/api/orgs/" + org + "/projects")).json();
  document.getElementById("rows").innerHTML = data.projects.map(function (p) {
    return "<tr><td>" + esc(p.id) + "</td><td>" + esc(p.name) + '</td><td><button onclick="show(\\'' + p.id + '\\')">Open</button> <button onclick="imp(\\'' + p.id + '\\')">Import notes…</button></td></tr>';
  }).join("");
}
async function show(id) {
  const r = await fetch("/api/orgs/" + org + "/projects/" + id);
  const d = await r.json();
  document.getElementById("notes").textContent = r.ok ? d.project.notes : d.error;
}
async function imp(id) {
  const from = prompt("Project id to import notes from?");
  if (!from) return;
  const r = await fetch("/api/orgs/" + org + "/projects/" + id + "/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fromProjectId: from }) });
  if (!r.ok) alert((await r.json()).error);
  show(id);
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/projects", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(viewer(req) ? "/projects" : "/login"));

  app.get("/projects", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Projects",
      `<div class="panel"><h1>Projects</h1>
        <table><tr><th>Id</th><th>Name</th><th></th></tr><tbody id="rows"></tbody></table>
        <pre id="notes" class="muted" style="white-space:pre-wrap;"></pre></div>
      <script>${PAGE_SCRIPT}</script>`,
      u.displayName,
    );
  });

  app.get("/api/me", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { username: u.username, orgs: u.orgs };
  });

  // Every nested route first checks membership of :org.
  const member = (req: Parameters<typeof sessions.read>[0], reply: { code: (n: number) => { send: (b: unknown) => unknown } }, org: string) => {
    const u = viewer(req);
    if (!u) {
      reply.code(401).send({ error: "login required" });
      return null;
    }
    if (!u.orgs.includes(org)) {
      reply.code(403).send({ error: "you are not a member of this organization" });
      return null;
    }
    return u;
  };

  app.get("/api/orgs/:org/projects", async (req, reply) => {
    const org = (req.params as { org: string }).org;
    if (!member(req, reply, org)) return;
    return { projects: PROJECTS.filter((p) => p.org === org).map((p) => ({ id: p.id, name: p.name })) };
  });

  // Correct: the project must belong to the org in the path.
  app.get("/api/orgs/:org/projects/:id", async (req, reply) => {
    const { org, id } = req.params as { org: string; id: string };
    if (!member(req, reply, org)) return;
    const p = PROJECTS.find((x) => x.id === id && x.org === org);
    if (!p) return reply.code(404).send({ error: "no such project" });
    return { project: p };
  });

  // --- The vulnerable handler: the SOURCE of the copy is looked up globally. ---------
  app.post("/api/orgs/:org/projects/:id/import", async (req, reply) => {
    const { org, id } = req.params as { org: string; id: string };
    const u = member(req, reply, org);
    if (!u) return;
    const target = PROJECTS.find((x) => x.id === id && x.org === org);
    if (!target) return reply.code(404).send({ error: "no such project" });
    const from = ((req.body ?? {}) as { fromProjectId?: unknown }).fromProjectId;
    if (typeof from !== "string") return reply.code(400).send({ error: "fromProjectId is required" });
    const source = PROJECTS.find((x) => x.id === from);
    if (!source) return reply.code(404).send({ error: "no such source project" });
    target.notes = `${target.notes}\n\n--- imported from ${source.name} ---\n${source.notes}`;
    if (source.org !== org) {
      await reportSolve(ctx, `"${u.username}" (org "${org}") imported the notes of project ${source.id} ("${source.name}") from organization "${source.org}" into ${target.id}`);
    }
    return { project: target };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[folio] fatal error:", err);
  process.exit(1);
});
