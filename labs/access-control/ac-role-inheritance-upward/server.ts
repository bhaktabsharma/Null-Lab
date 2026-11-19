/**
 * Foldr — Team Drive (role inheritance resolved in the wrong direction)
 *
 * Permissions are granted on folders and should flow DOWN the tree: editor on a
 * folder means editor on everything inside it. The effective-role resolver was
 * written to also let people navigate to a folder they were given deep in the
 * tree, so it counts grants on ancestors AND on descendants of the folder being
 * checked. The write endpoint reuses it. Recorded only when a file is edited by
 * someone who has no legitimate (ancestor-or-self) editor grant for its folder.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Foldr";

interface User {
  username: string;
  password: string;
  displayName: string;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "tess", password: "Owner-Foldr!71", displayName: "Tess Duarte" },
];

interface Folder {
  id: string;
  name: string;
  parent: string | null;
}
const FOLDERS: Folder[] = [
  { id: "c0", name: "Company", parent: null },
  { id: "fin", name: "Finance", parent: "c0" },
  { id: "pay", name: "Payroll", parent: "fin" },
  { id: "mkt", name: "Marketing", parent: "c0" },
  { id: "cmp", name: "Campaigns", parent: "mkt" },
];
interface DriveFile {
  id: string;
  folder: string;
  name: string;
  content: string;
}
const FILES: DriveFile[] = [
  { id: "doc-c0-1", folder: "c0", name: "Company-handbook.txt", content: "SYNTHETIC handbook v3 — office hours 9 to 5." },
  { id: "doc-fin-1", folder: "fin", name: "Budget-2025.txt", content: "SYNTHETIC budget — headcount plan and runway." },
  { id: "doc-pay-1", folder: "pay", name: "Payroll-run.txt", content: "SYNTHETIC payroll run — September." },
  { id: "doc-mkt-1", folder: "mkt", name: "Pricing-strategy.txt", content: "SYNTHETIC pricing strategy — launch tiers: 19 / 49 / 99." },
  { id: "doc-cmp-1", folder: "cmp", name: "Q4-campaign-brief.txt", content: "SYNTHETIC Q4 campaign brief — theme: Winter Reset." },
];

type Role = "viewer" | "editor" | "owner";
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const GRANTS: { user: string; folder: string; role: Role }[] = [
  { user: "tess", folder: "c0", role: "owner" },
  { user: "alice", folder: "cmp", role: "editor" }, // alice works on campaigns only
];

const byId = (id: string) => FOLDERS.find((f) => f.id === id);
/** self first, then each ancestor up to the root */
function chain(id: string): string[] {
  const out: string[] = [];
  for (let cur = byId(id); cur; cur = cur.parent ? byId(cur.parent) : undefined) out.push(cur.id);
  return out;
}
const isAncestorOrSelf = (maybeAncestor: string, of: string) => chain(of).includes(maybeAncestor);

/** Correct inheritance: only grants on the folder itself or an ancestor apply. */
function inheritedRole(user: string, folder: string): number {
  return Math.max(0, ...GRANTS.filter((g) => g.user === user && isAncestorOrSelf(g.folder, folder)).map((g) => RANK[g.role]));
}
/**
 * "Navigation" resolver — also counts grants on DESCENDANTS, so someone shared into
 * Campaigns can still open Marketing and Company to get there. It is used for the
 * folder listing AND (wrongly) for the write check below.
 */
function effectiveRole(user: string, folder: string): number {
  return Math.max(0, ...GRANTS.filter((g) => g.user === user && (isAncestorOrSelf(g.folder, folder) || isAncestorOrSelf(folder, g.folder))).map((g) => RANK[g.role]));
}

const sessions = makeSessions<{ user: string }>(ctx, "foldr_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#bd93f9",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/drive", label: "Drive" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
let current = null;
async function load() {
  const tree = await (await fetch("/api/folders")).json();
  document.getElementById("tree").innerHTML = tree.folders.map(function (f) {
    return '<li><a href="#" onclick="openFolder(\\'' + f.id + '\\'); return false;">' + esc(f.name) + "</a> <span class=muted>(" + esc(f.access) + ")</span></li>";
  }).join("");
}
async function openFolder(id) {
  current = id;
  const data = await (await fetch("/api/folders/" + id)).json();
  document.getElementById("files").innerHTML = data.files.map(function (f) {
    const edit = data.access === "editor access" ? '<button onclick="edit(\\'' + f.id + '\\')">Edit</button>' : "";
    return "<tr><td>" + esc(f.name) + "</td><td>" + esc(f.id) + "</td><td>" + edit + "</td></tr>";
  }).join("");
}
async function edit(id) {
  const text = prompt("New content?");
  if (text === null) return;
  const r = await fetch("/api/files/" + id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text }) });
  if (!r.ok) alert((await r.json()).error);
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  const label = (rank: number, inherited: number) => (inherited >= RANK.editor ? "editor access" : inherited >= 1 ? "read-only" : rank > 0 ? "navigation only" : "none");

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/drive", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/drive" : "/login"));

  app.get("/drive", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Drive",
      `<div class="panel"><h1>Team drive</h1><ul id="tree"></ul></div>
       <div class="panel"><table><tr><th>File</th><th>Id</th><th></th></tr><tbody id="files"></tbody></table></div>
       <script>${PAGE_SCRIPT}</script>`,
      USERS.find((x) => x.username === u)?.displayName,
    );
  });

  app.get("/api/folders", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return {
      folders: FOLDERS.filter((f) => effectiveRole(u, f.id) > 0).map((f) => ({ id: f.id, name: f.name, access: label(effectiveRole(u, f.id), inheritedRole(u, f.id)) })),
    };
  });

  app.get("/api/folders/:id", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const id = (req.params as { id: string }).id;
    if (!byId(id) || effectiveRole(u, id) === 0) return reply.code(404).send({ error: "no such folder" });
    // Listing shows file names/ids for navigation; content needs a real (inherited) grant.
    return { folder: byId(id), access: label(effectiveRole(u, id), inheritedRole(u, id)), files: FILES.filter((f) => f.folder === id).map((f) => ({ id: f.id, name: f.name })) };
  });

  app.get("/api/files/:id", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const f = FILES.find((x) => x.id === (req.params as { id: string }).id);
    if (!f || inheritedRole(u, f.folder) < RANK.viewer) return reply.code(404).send({ error: "no such file" });
    return { file: f };
  });

  // --- The vulnerable handler: write check uses the navigation resolver. ------------
  app.put("/api/files/:id", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const f = FILES.find((x) => x.id === (req.params as { id: string }).id);
    if (!f || effectiveRole(u, f.folder) === 0) return reply.code(404).send({ error: "no such file" });
    if (effectiveRole(u, f.folder) < RANK.editor) return reply.code(403).send({ error: "you only have read access here" });
    const content = ((req.body ?? {}) as { content?: unknown }).content;
    if (typeof content !== "string" || content.length > 2000) return reply.code(400).send({ error: "content must be a string" });
    f.content = content;
    if (inheritedRole(u, f.folder) < RANK.editor) {
      const folder = byId(f.folder)!;
      await reportSolve(ctx, `"${u}" edited file ${f.id} in folder "${folder.name}" with no editor grant on it or any ancestor — only a grant on a folder BELOW it`);
    }
    return { file: { id: f.id, name: f.name, content: f.content } };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[foldr] fatal error:", err);
  process.exit(1);
});
