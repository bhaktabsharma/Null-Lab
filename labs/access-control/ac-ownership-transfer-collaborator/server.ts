/**
 * Atlas — Project Hand-over (unauthorized ownership transfer)
 *
 * Only owners see the "Transfer ownership" button, and the archive and
 * add-collaborator endpoints check for the owner correctly. The transfer
 * endpoint checks that the caller belongs to the project — owner OR
 * collaborator — instead of that they own it. Recorded only when a transfer
 * succeeds for a caller who is not the project's current owner.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Atlas";

interface User {
  username: string;
  password: string;
  displayName: string;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "tess", password: "Owner-Atlas!31", displayName: "Tess Duarte" },
  { username: "carol", password: "Owner-Atlas!32", displayName: "Carol Reyes" },
  { username: "ben", password: "collab-pass-7", displayName: "Ben Hollis" },
];

interface Project {
  id: string;
  name: string;
  owner: string;
  collaborators: string[];
  archived: boolean;
}
const projects: Project[] = [
  { id: "p1", name: "Q4 Launch Plan", owner: "tess", collaborators: ["alice", "ben"], archived: false },
  { id: "p2", name: "Brand Guidelines 2.0", owner: "carol", collaborators: ["ben"], archived: false },
  { id: "p3", name: "Pricing Model", owner: "tess", collaborators: [], archived: false },
];

const sessions = makeSessions<{ user: string }>(ctx, "atlas_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#ffb86c",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/projects", label: "Projects" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const data = await (await fetch("/api/projects")).json();
  document.getElementById("rows").innerHTML = data.projects.map(function (p) {
    const owner = p.yourRole === "owner";
    const actions = owner
      ? '<button onclick="act(\\'' + p.id + '\\', \\'transfer\\')">Transfer ownership</button> <button onclick="act(\\'' + p.id + '\\', \\'archive\\')">Archive</button>'
      : "";
    return "<tr><td>" + esc(p.name) + "</td><td>" + esc(p.owner) + "</td><td>" + esc(p.yourRole) + "</td><td>" + (p.archived ? "archived" : actions) + "</td></tr>";
  }).join("");
}
async function act(id, what) {
  if (what === "transfer") {
    const to = prompt("Transfer to which username?");
    if (!to) return;
    const r = await fetch("/api/projects/" + id + "/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newOwner: to }) });
    if (!r.ok) alert((await r.json()).error);
  } else {
    await fetch("/api/projects/" + id + "/archive", { method: "POST" });
  }
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  const roleIn = (p: Project, user: string) => (p.owner === user ? "owner" : p.collaborators.includes(user) ? "collaborator" : null);

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/projects", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/projects" : "/login"));

  app.get("/projects", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Projects",
      `<div class="panel"><h1>Your projects</h1>
        <table><tr><th>Project</th><th>Owner</th><th>Your role</th><th></th></tr><tbody id="rows"></tbody></table></div>
      <script>${PAGE_SCRIPT}</script>`,
      USERS.find((x) => x.username === u)?.displayName,
    );
  });

  app.get("/api/projects", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return {
      projects: projects.filter((p) => roleIn(p, u)).map((p) => ({ id: p.id, name: p.name, owner: p.owner, archived: p.archived, yourRole: roleIn(p, u) })),
    };
  });

  app.get("/api/projects/:id", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const p = projects.find((x) => x.id === (req.params as { id: string }).id);
    if (!p || !roleIn(p, u)) return reply.code(404).send({ error: "no such project" });
    return { project: { id: p.id, name: p.name, owner: p.owner, collaborators: p.collaborators, archived: p.archived } };
  });

  // Correctly protected: only the owner.
  app.post("/api/projects/:id/archive", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const p = projects.find((x) => x.id === (req.params as { id: string }).id);
    if (!p || !roleIn(p, u)) return reply.code(404).send({ error: "no such project" });
    if (p.owner !== u) return reply.code(403).send({ error: "only the project owner can do this" });
    p.archived = true;
    return { archived: p.id };
  });

  app.post("/api/projects/:id/collaborators", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const p = projects.find((x) => x.id === (req.params as { id: string }).id);
    if (!p || !roleIn(p, u)) return reply.code(404).send({ error: "no such project" });
    if (p.owner !== u) return reply.code(403).send({ error: "only the project owner can do this" });
    const name = ((req.body ?? {}) as { username?: unknown }).username;
    if (typeof name !== "string" || !USERS.some((x) => x.username === name)) return reply.code(400).send({ error: "unknown user" });
    if (!p.collaborators.includes(name) && p.owner !== name) p.collaborators.push(name);
    return { collaborators: p.collaborators };
  });

  // --- The vulnerable handler: "is this person on the project?" instead of "do they own it?" ---
  app.post("/api/projects/:id/transfer", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const p = projects.find((x) => x.id === (req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "no such project" });
    if (!roleIn(p, u)) return reply.code(403).send({ error: "you are not on this project" });
    const target = ((req.body ?? {}) as { newOwner?: unknown }).newOwner;
    if (typeof target !== "string" || !USERS.some((x) => x.username === target)) return reply.code(400).send({ error: "unknown user" });
    if (target === p.owner) return reply.code(400).send({ error: "that user already owns the project" });

    const previous = p.owner;
    p.collaborators = p.collaborators.filter((c) => c !== target);
    if (!p.collaborators.includes(previous)) p.collaborators.push(previous);
    p.owner = target;
    if (previous !== u) {
      await reportSolve(ctx, `"${u}" (a collaborator, not the owner) transferred ownership of project ${p.id} ("${p.name}") from "${previous}" to "${target}"`);
    }
    return { project: { id: p.id, owner: p.owner, collaborators: p.collaborators } };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[atlas] fatal error:", err);
  process.exit(1);
});
