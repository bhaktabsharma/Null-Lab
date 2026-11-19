/**
 * Briefcase Docs — Attach to Project (ownership changes between check and use)
 *
 * Attaching a document to a project shares it with every project member. The
 * endpoint checks that the caller owns the document, then runs a (simulated,
 * slow) virus scan, then writes the attachment — without checking ownership
 * again. Transferring a document is immediate and correct on its own: it
 * clears any attachment. Done one after the other, neither action is unsafe.
 * Recorded only when an attachment is WRITTEN for a caller who no longer owns
 * the document, i.e. the two requests overlapped.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Briefcase Docs";
const SCAN_MS = 350;

interface User {
  username: string;
  password: string;
  displayName: string;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "bob", password: "Buyer-Brief!41", displayName: "Bob Marsh" },
  { username: "carol", password: "Team-Brief!42", displayName: "Carol Reyes" },
  { username: "dave", password: "Team-Brief!43", displayName: "Dave Park" },
];
interface Project {
  id: string;
  name: string;
  members: string[];
}
const PROJECTS: Project[] = [{ id: "studio", name: "Studio Team", members: ["alice", "carol", "dave"] }];
interface Doc {
  id: string;
  name: string;
  owner: string;
  body: string;
  attachedProject: string | null;
  attachedBy: string | null;
}
const DOCS: Doc[] = [
  { id: "d1", name: "Merger-draft.txt", owner: "alice", body: "SYNTHETIC merger draft — price per share 41.20, exclusivity 60 days.", attachedProject: null, attachedBy: null },
  { id: "d2", name: "Term-sheet.txt", owner: "alice", body: "SYNTHETIC term sheet — board seats: 2 of 7.", attachedProject: null, attachedBy: null },
  { id: "d3", name: "Lunch-menu.txt", owner: "bob", body: "SYNTHETIC lunch menu — tacos on Friday.", attachedProject: null, attachedBy: null },
];

const sessions = makeSessions<{ user: string }>(ctx, "briefcase_session");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#8be9fd",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/docs", label: "Documents" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const data = await (await fetch("/api/docs")).json();
  document.getElementById("rows").innerHTML = data.docs.map(function (d) {
    const mine = d.owner === data.you;
    const actions = mine ? '<button onclick="attach(\\'' + d.id + '\\')">Attach to Studio Team</button> <button onclick="giveAway(\\'' + d.id + '\\')">Transfer</button>' : "";
    return "<tr><td>" + esc(d.id) + "</td><td>" + esc(d.name) + "</td><td>" + esc(d.owner) + "</td><td>" + esc(d.attachedProject || "—") + "</td><td>" + actions + "</td></tr>";
  }).join("");
}
async function attach(id) {
  document.getElementById("msg").textContent = "Scanning for viruses…";
  const r = await fetch("/api/docs/" + id + "/attach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "studio" }) });
  document.getElementById("msg").textContent = r.ok ? "Attached." : (await r.json()).error;
  load();
}
async function giveAway(id) {
  const to = prompt("Transfer to which username?");
  if (!to) return;
  const r = await fetch("/api/docs/" + id + "/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: to }) });
  if (!r.ok) alert((await r.json()).error);
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  const canSee = (d: Doc, u: string) => d.owner === u || (d.attachedProject !== null && !!PROJECTS.find((p) => p.id === d.attachedProject)?.members.includes(u));

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/docs", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/docs" : "/login"));

  app.get("/docs", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Documents",
      `<div class="panel"><h1>Documents</h1><p class="muted" id="msg"></p>
        <table><tr><th>Id</th><th>Name</th><th>Owner</th><th>Attached to</th><th></th></tr><tbody id="rows"></tbody></table></div>
      <script>${PAGE_SCRIPT}</script>`,
      USERS.find((x) => x.username === u)?.displayName,
    );
  });

  app.get("/api/docs", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { you: u, docs: DOCS.filter((d) => canSee(d, u)).map((d) => ({ id: d.id, name: d.name, owner: d.owner, attachedProject: d.attachedProject })) };
  });

  app.get("/api/docs/:id", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const d = DOCS.find((x) => x.id === (req.params as { id: string }).id);
    if (!d || !canSee(d, u)) return reply.code(404).send({ error: "no such document" });
    return { doc: { id: d.id, name: d.name, owner: d.owner, body: d.body, attachedProject: d.attachedProject } };
  });

  // --- Check ... wait ... use -------------------------------------------------------
  app.post("/api/docs/:id/attach", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const d = DOCS.find((x) => x.id === (req.params as { id: string }).id);
    if (!d) return reply.code(404).send({ error: "no such document" });
    const projectId = ((req.body ?? {}) as { projectId?: unknown }).projectId;
    const project = PROJECTS.find((p) => p.id === projectId);
    if (!project) return reply.code(400).send({ error: "unknown project" });
    if (!project.members.includes(u)) return reply.code(403).send({ error: "you are not a member of that project" });
    if (d.owner !== u) return reply.code(403).send({ error: "only the owner can attach a document" }); // the check

    await sleep(SCAN_MS); // virus scan

    d.attachedProject = project.id; // the use — ownership is not re-checked
    d.attachedBy = u;
    if (d.owner !== u) {
      await reportSolve(ctx, `"${u}" attached ${d.id} ("${d.name}") to project "${project.name}" at a moment when "${d.owner}" owned it — ownership changed between the check and the write`);
    }
    return { doc: { id: d.id, owner: d.owner, attachedProject: d.attachedProject } };
  });

  // Correct on its own: immediate, owner-only, and it clears any attachment.
  app.post("/api/docs/:id/transfer", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const d = DOCS.find((x) => x.id === (req.params as { id: string }).id);
    if (!d) return reply.code(404).send({ error: "no such document" });
    if (d.owner !== u) return reply.code(403).send({ error: "only the owner can transfer a document" });
    const to = ((req.body ?? {}) as { to?: unknown }).to;
    if (typeof to !== "string" || !USERS.some((x) => x.username === to)) return reply.code(400).send({ error: "unknown user" });
    d.owner = to;
    d.attachedProject = null;
    d.attachedBy = null;
    return { doc: { id: d.id, owner: d.owner, attachedProject: d.attachedProject } };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[briefcase-docs] fatal error:", err);
  process.exit(1);
});
