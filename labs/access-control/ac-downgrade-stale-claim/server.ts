/**
 * Notely — Shared Notes (permission downgrade not enforced)
 *
 * The signed session cookie carries the user's role as a claim, copied from the
 * member record at login. Administrators can change roles, and the member list
 * and `/api/me` show the CURRENT record — but the note-writing endpoints decide
 * from the claim in the cookie. A downgraded user whose session is still open
 * keeps editing until they sign in again. Recorded only when a write is accepted
 * for a user whose current role is below editor.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, CLIENT_ESC_JS, escapeHtml } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Notely";

type Role = "viewer" | "editor" | "admin";
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
const isRole = (r: unknown): r is Role => typeof r === "string" && Object.prototype.hasOwnProperty.call(RANK, r);

interface Member {
  username: string;
  password: string;
  displayName: string;
  role: Role;
}
const MEMBERS: Member[] = [
  { username: "ben", password: "Editor-Notely!81", displayName: "Ben Hollis", role: "editor" },
  { username: "tess", password: "Admin-Notely!82", displayName: "Tess Duarte", role: "admin" },
  { username: "alice", password: "practice123", displayName: "Alice Chen", role: "viewer" },
];
interface Note {
  id: string;
  text: string;
  updatedBy: string;
}
const notes: Note[] = [
  { id: "n1", text: "Sprint goals: ship the importer, fix the export bug.", updatedBy: "tess" },
  { id: "n2", text: "Retro actions: tidy the backlog, rotate on-call.", updatedBy: "ben" },
];

// The role is copied into the signed cookie at login.
const sessions = makeSessions<{ user: string; role: Role }>(ctx, "notely_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#ffb86c",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/notes", label: "Notes" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const me = await (await fetch("/api/me")).json();
  const list = await (await fetch("/api/notes")).json();
  document.getElementById("who").textContent = me.username + " — " + me.role;
  document.getElementById("rows").innerHTML = list.notes.map(function (n) {
    const edit = me.role === "viewer" ? "" : '<button onclick="edit(\\'' + n.id + '\\')">Edit</button>';
    return "<tr><td>" + esc(n.id) + "</td><td>" + esc(n.text) + "</td><td>" + esc(n.updatedBy) + "</td><td>" + edit + "</td></tr>";
  }).join("");
  if (me.role === "admin") {
    const m = await (await fetch("/api/members")).json();
    document.getElementById("admin").innerHTML = "<h2>Members</h2>" + m.members.map(function (x) {
      return "<p>" + esc(x.username) + " — " + esc(x.role) + ' <button onclick="setRole(\\'' + x.username + '\\', \\'viewer\\')">Make viewer</button> <button onclick="setRole(\\'' + x.username + '\\', \\'editor\\')">Make editor</button></p>';
    }).join("");
  }
}
async function edit(id) {
  const text = prompt("New text?");
  if (text === null) return;
  const r = await fetch("/api/notes/" + id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text }) });
  if (!r.ok) alert((await r.json()).error);
  load();
}
async function setRole(u, role) {
  await fetch("/api/members/" + u + "/role", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: role }) });
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const claim = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req);
  const record = (username: string) => MEMBERS.find((m) => m.username === username);

  // Own login routes: the cookie must carry the role claim.
  app.get("/login", async (req, reply) => {
    const err = (req.query as { error?: string } | undefined)?.error;
    reply.type("text/html");
    return shell(
      "Sign in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Sign in to ${escapeHtml(APP)}</h1>
        ${err ? `<p class="muted" style="color:#e07a7a;">Incorrect username or password.</p>` : ""}
        <form method="post" action="/login">
          <p><input type="text" name="username" placeholder="Username" autocomplete="username" /></p>
          <p><input type="password" name="password" placeholder="Password" autocomplete="current-password" /></p>
          <button type="submit">Sign in</button></form>
        <p class="muted" style="margin-top:1rem;">Demo account: <strong>ben</strong> / Editor-Notely!81</p></div>`,
    );
  });
  app.post("/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const m = MEMBERS.find((x) => typeof b.username === "string" && typeof b.password === "string" && x.username === b.username && x.password === b.password);
    if (!m) return reply.redirect("/login?error=1");
    sessions.set(reply, { user: m.username, role: m.role });
    return reply.redirect("/notes");
  });
  app.get("/logout", async (_req, reply) => {
    sessions.clear(reply);
    return reply.redirect("/login");
  });
  app.get("/", async (req, reply) => reply.redirect(claim(req) ? "/notes" : "/login"));

  app.get("/notes", async (req, reply) => {
    const c = claim(req);
    if (!c) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Notes",
      `<div class="panel"><h1>Shared notes</h1><p class="muted" id="who"></p>
        <table><tr><th>Id</th><th>Note</th><th>Last edited by</th><th></th></tr><tbody id="rows"></tbody></table></div>
        <div class="panel" id="admin"></div><script>${PAGE_SCRIPT}</script>`,
      record(c.user)?.displayName,
    );
  });

  // /api/me and the member list show the CURRENT record.
  app.get("/api/me", async (req, reply) => {
    const c = claim(req);
    const m = c && record(c.user);
    if (!m) return reply.code(401).send({ error: "login required" });
    return { username: m.username, role: m.role };
  });
  app.get("/api/members", async (req, reply) => {
    const c = claim(req);
    const m = c && record(c.user);
    if (!m) return reply.code(401).send({ error: "login required" });
    if (m.role !== "admin") return reply.code(403).send({ error: "administrators only" });
    return { members: MEMBERS.map((x) => ({ username: x.username, role: x.role })) };
  });
  app.get("/api/notes", async (req, reply) => {
    if (!claim(req)) return reply.code(401).send({ error: "login required" });
    return { notes };
  });

  // Role changes check the CURRENT record of the admin making them (correct).
  app.patch("/api/members/:username/role", async (req, reply) => {
    const c = claim(req);
    const admin = c && record(c.user);
    if (!admin) return reply.code(401).send({ error: "login required" });
    if (admin.role !== "admin") return reply.code(403).send({ error: "administrators only" });
    const target = record((req.params as { username: string }).username);
    if (!target) return reply.code(404).send({ error: "no such member" });
    const role = ((req.body ?? {}) as { role?: unknown }).role;
    if (!isRole(role)) return reply.code(400).send({ error: "unknown role" });
    if (target.username === admin.username) return reply.code(400).send({ error: "you cannot change your own role" });
    target.role = role;
    return { member: { username: target.username, role: target.role } };
  });

  // --- The vulnerable handler: decides from the cookie's claim, not the record. -----
  app.put("/api/notes/:id", async (req, reply) => {
    const c = claim(req);
    const m = c && record(c.user);
    if (!c || !m) return reply.code(401).send({ error: "login required" });
    if (RANK[c.role] < RANK.editor) return reply.code(403).send({ error: "editors only" });
    const note = notes.find((n) => n.id === (req.params as { id: string }).id);
    if (!note) return reply.code(404).send({ error: "no such note" });
    const text = ((req.body ?? {}) as { text?: unknown }).text;
    if (typeof text !== "string" || text.length === 0 || text.length > 500) return reply.code(400).send({ error: "text must be 1-500 characters" });
    note.text = text;
    note.updatedBy = m.username;
    if (RANK[m.role] < RANK.editor) {
      await reportSolve(ctx, `"${m.username}" edited note ${note.id} while their current role is "${m.role}" — the write was authorized by the "${c.role}" claim in their old session cookie`);
    }
    return { note };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[notely] fatal error:", err);
  process.exit(1);
});
