/**
 * Orbit — Invite Your Team (organization invitation privilege escalation)
 *
 * Any member may invite colleagues, and the invite form only offers the two
 * lowest roles. The server's own check is partial: it rejects unknown roles
 * and refuses to mint owners, but never compares the requested role with the
 * inviter's own — so a member can create an administrator invitation.
 * Recorded only when an invitation is ACCEPTED and the new account really
 * holds a higher role than the person who invited it.
 */
import { randomBytes } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Orbit";
const WORKSPACE = "Northwind Studio";

type Role = "viewer" | "member" | "admin" | "owner";
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const isRole = (r: unknown): r is Role => typeof r === "string" && Object.prototype.hasOwnProperty.call(RANK, r);

interface User {
  username: string;
  password: string;
  displayName: string;
  email: string;
  role: Role;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", email: "alice@northwind.example", role: "member" },
  { username: "tess", password: "Adm1n-Orbit!42", displayName: "Tess Duarte", email: "tess@northwind.example", role: "owner" },
  { username: "ben", password: "viewer-only-9", displayName: "Ben Hollis", email: "ben@northwind.example", role: "viewer" },
];

interface Invite {
  token: string;
  email: string;
  role: Role;
  createdBy: string;
  createdByRole: Role;
  acceptedBy?: string;
}
const invites: Invite[] = [];

const sessions = makeSessions<{ user: string }>(ctx, "orbit_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#5ac8fa",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/workspace", label: "Workspace" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const me = await (await fetch("/api/me")).json();
  const members = await (await fetch("/api/members")).json();
  document.getElementById("rows").innerHTML = members.members.map(function (m) {
    return "<tr><td>" + esc(m.displayName) + "</td><td>" + esc(m.email) + "</td><td>" + esc(m.role) + "</td></tr>";
  }).join("");
  const mine = await (await fetch("/api/invites")).json();
  document.getElementById("pending").innerHTML = mine.invites.length === 0 ? "<tr><td colspan=3 class=muted>No invitations yet.</td></tr>" :
    mine.invites.map(function (i) {
      return "<tr><td>" + esc(i.email) + "</td><td>" + esc(i.role) + "</td><td>" + (i.acceptedBy ? "accepted" : '<a href="' + esc(i.link) + '">join link</a>') + "</td></tr>";
    }).join("");
  document.getElementById("invite-box").style.display = me.role === "viewer" ? "none" : "block";
}
async function invite(ev) {
  ev.preventDefault();
  const email = document.getElementById("email").value;
  const role = document.getElementById("role").value;
  const res = await fetch("/api/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email, role: role }) });
  document.getElementById("msg").textContent = res.ok ? "Invitation created." : (await res.json()).error;
  load();
}
document.getElementById("invite-form").addEventListener("submit", invite);
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/workspace", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(viewer(req) ? "/workspace" : "/login"));

  app.get("/workspace", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Workspace",
      `<div class="panel"><h1>${WORKSPACE}</h1>
        <table><tr><th>Name</th><th>Email</th><th>Role</th></tr><tbody id="rows"></tbody></table></div>
      <div class="panel" id="invite-box"><h2>Invite a teammate</h2>
        <form id="invite-form">
          <p><input id="email" type="email" placeholder="colleague@company.example" required /></p>
          <p><select id="role"><option value="viewer">Viewer</option><option value="member" selected>Member</option></select></p>
          <button type="submit">Send invitation</button> <span id="msg" class="muted"></span>
        </form>
        <h3>Your invitations</h3>
        <table><tr><th>Email</th><th>Role</th><th></th></tr><tbody id="pending"></tbody></table></div>
      <script>${PAGE_SCRIPT}</script>`,
      u.displayName,
    );
  });

  app.get("/api/me", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { username: u.username, displayName: u.displayName, role: u.role, workspace: WORKSPACE };
  });

  app.get("/api/members", async (req, reply) => {
    if (!viewer(req)) return reply.code(401).send({ error: "login required" });
    return { members: USERS.map((u) => ({ username: u.username, displayName: u.displayName, email: u.email, role: u.role })) };
  });

  app.get("/api/invites", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { invites: invites.filter((i) => i.createdBy === u.username).map((i) => ({ email: i.email, role: i.role, acceptedBy: i.acceptedBy, link: `/join/${i.token}` })) };
  });

  // --- The vulnerable handler -------------------------------------------------
  app.post("/api/invites", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    if (RANK[u.role] < RANK.member) return reply.code(403).send({ error: "viewers cannot invite people" });
    const body = (req.body ?? {}) as { email?: unknown; role?: unknown };
    if (typeof body.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) return reply.code(400).send({ error: "a valid email is required" });
    if (!isRole(body.role)) return reply.code(400).send({ error: "unknown role" });
    // Partial protection: owners can only be created by owners. Nothing stops a member
    // from asking for "admin" — the requested role is never compared with the inviter's own.
    if (body.role === "owner" && u.role !== "owner") return reply.code(403).send({ error: "only an owner can invite an owner" });
    const email = body.email.toLowerCase();
    if (USERS.some((x) => x.email === email)) return reply.code(409).send({ error: "that person is already in the workspace" });
    if (invites.some((i) => i.email === email && !i.acceptedBy)) return reply.code(409).send({ error: "an invitation for that address is already pending" });
    const invite: Invite = { token: randomBytes(9).toString("hex"), email, role: body.role, createdBy: u.username, createdByRole: u.role };
    invites.push(invite);
    return { invite: { email, role: invite.role, token: invite.token, link: `/join/${invite.token}` } };
  });

  app.get("/join/:token", async (req, reply) => {
    const inv = invites.find((i) => i.token === (req.params as { token: string }).token);
    reply.type("text/html");
    if (!inv || inv.acceptedBy) return reply.code(404).send(shell("Invitation", `<div class="panel"><h1>Invitation not found</h1><p class="muted">This link is invalid or has already been used.</p></div>`));
    return shell(
      "Join",
      `<div class="panel" style="max-width:420px;margin:3rem auto;"><h1>Join ${WORKSPACE}</h1>
        <p class="muted">Invitation for ${inv.email}.</p>
        <form id="f"><p><input id="u" placeholder="Choose a username" required /></p><p><input id="p" type="password" placeholder="Choose a password" required /></p><button>Create account</button> <span id="m" class="muted"></span></form></div>
      <script>document.getElementById("f").addEventListener("submit", async function (e) { e.preventDefault();
        const r = await fetch("/api/invites/${inv.token}/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: document.getElementById("u").value, password: document.getElementById("p").value }) });
        if (r.ok) location.href = "/workspace"; else document.getElementById("m").textContent = (await r.json()).error; });</script>`,
    );
  });

  app.post("/api/invites/:token/accept", async (req, reply) => {
    const inv = invites.find((i) => i.token === (req.params as { token: string }).token);
    if (!inv || inv.acceptedBy) return reply.code(404).send({ error: "invitation not found or already used" });
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof body.username !== "string" || !/^[a-z0-9_-]{3,20}$/i.test(body.username)) return reply.code(400).send({ error: "username must be 3-20 letters, digits, - or _" });
    if (typeof body.password !== "string" || body.password.length < 6) return reply.code(400).send({ error: "password must be at least 6 characters" });
    if (USERS.some((x) => x.username === body.username)) return reply.code(409).send({ error: "that username is taken" });
    const user: User = { username: body.username, password: body.password, displayName: body.username, email: inv.email, role: inv.role };
    USERS.push(user);
    inv.acceptedBy = user.username;
    sessions.set(reply, { user: user.username });
    if (RANK[inv.role] > RANK[inv.createdByRole]) {
      await reportSolve(ctx, `invitation created by "${inv.createdBy}" (role "${inv.createdByRole}") was accepted and the new account "${user.username}" now holds role "${inv.role}" — above its inviter`);
    }
    return { user: { username: user.username, role: user.role } };
  });

  // An ordinary, correctly protected admin action, so the new role has something to do.
  app.post("/api/members/:username/remove", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    if (RANK[u.role] < RANK.admin) return reply.code(403).send({ error: "administrators only" });
    const name = (req.params as { username: string }).username;
    const idx = USERS.findIndex((x) => x.username === name);
    if (idx < 0) return reply.code(404).send({ error: "no such member" });
    if (USERS[idx]!.role === "owner") return reply.code(403).send({ error: "owners cannot be removed" });
    USERS.splice(idx, 1);
    return { removed: name };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[orbit] fatal error:", err);
  process.exit(1);
});
