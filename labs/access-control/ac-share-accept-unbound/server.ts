/**
 * Docly — Shared With You (share acceptance not bound to the recipient)
 *
 * Sharing a document creates a pending share addressed to an email. The
 * recipient sees their own pending shares and accepts one by its id. The
 * accept endpoint looks the share up by id and grants access to whoever is
 * signed in — it never checks that the share was addressed to them. Share ids
 * are sequential. Document reads are checked correctly. Recorded only when a
 * share is accepted by an account whose email is not the one it was sent to.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Docly";

interface User {
  username: string;
  password: string;
  displayName: string;
  email: string;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", email: "alice@docly.example" },
  { username: "dana", password: "Dana-Docly!31", displayName: "Dana Whitfield", email: "dana@docly.example" },
  { username: "ben", password: "Ben-Docly!32", displayName: "Ben Hollis", email: "ben@docly.example" },
  { username: "tess", password: "Owner-Docly!33", displayName: "Tess Duarte", email: "tess@docly.example" },
];
interface Doc {
  id: string;
  name: string;
  owner: string;
  body: string;
}
const DOCS: Doc[] = [
  { id: "d-901", name: "Salary-review-2024.txt", owner: "tess", body: "SYNTHETIC CONFIDENTIAL — salary review: Dana W. +6%, promotion to L6." },
  { id: "d-902", name: "Acquisition-notes.txt", owner: "tess", body: "SYNTHETIC CONFIDENTIAL — acquisition notes: shortlist ORCHID, BASALT." },
  { id: "d-903", name: "Team-lunch-menu.txt", owner: "ben", body: "SYNTHETIC — team lunch menu: tacos on Friday." },
];
interface Share {
  id: string;
  docId: string;
  recipientEmail: string;
  acceptedBy?: string;
}
const shares: Share[] = [
  { id: "sh-2041", docId: "d-901", recipientEmail: "dana@docly.example" },
  { id: "sh-2042", docId: "d-902", recipientEmail: "ben@docly.example" },
  { id: "sh-2043", docId: "d-903", recipientEmail: "alice@docly.example" },
];
const access = new Map<string, Set<string>>(); // docId -> usernames with access via an accepted share

const sessions = makeSessions<{ user: string }>(ctx, "docly_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#ff79c6",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/shared", label: "Shared with me" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const p = await (await fetch("/api/shares/pending")).json();
  document.getElementById("pending").innerHTML = p.shares.length === 0 ? "<tr><td colspan=3 class=muted>Nothing waiting.</td></tr>" :
    p.shares.map(function (s) {
      return "<tr><td>" + esc(s.id) + "</td><td>" + esc(s.docName) + '</td><td><button onclick="accept(\\'' + s.id + '\\')">Accept</button></td></tr>';
    }).join("");
  const d = await (await fetch("/api/docs")).json();
  document.getElementById("docs").innerHTML = d.docs.map(function (x) {
    return '<li><a href="#" onclick="openDoc(\\'' + x.id + '\\'); return false;">' + esc(x.name) + "</a></li>";
  }).join("");
}
async function accept(id) {
  const r = await fetch("/api/shares/" + id + "/accept", { method: "POST" });
  if (!r.ok) alert((await r.json()).error);
  load();
}
async function openDoc(id) {
  const r = await fetch("/api/docs/" + id);
  const d = await r.json();
  document.getElementById("body").textContent = r.ok ? d.doc.body : d.error;
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };
  const canRead = (d: Doc, u: User) => d.owner === u.username || access.get(d.id)?.has(u.username) === true;

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/shared", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(viewer(req) ? "/shared" : "/login"));

  app.get("/shared", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Shared with me",
      `<div class="panel"><h1>Waiting for you</h1>
        <table><tr><th>Share</th><th>Document</th><th></th></tr><tbody id="pending"></tbody></table></div>
       <div class="panel"><h2>Your documents</h2><ul id="docs"></ul><pre id="body" class="muted" style="white-space:pre-wrap;"></pre></div>
      <script>${PAGE_SCRIPT}</script>`,
      u.displayName,
    );
  });

  // Pending shares are listed correctly: only the ones addressed to you.
  app.get("/api/shares/pending", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return {
      shares: shares
        .filter((s) => s.recipientEmail === u.email && !s.acceptedBy)
        .map((s) => ({ id: s.id, docName: DOCS.find((d) => d.id === s.docId)!.name })),
    };
  });

  app.get("/api/docs", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { docs: DOCS.filter((d) => canRead(d, u)).map((d) => ({ id: d.id, name: d.name })) };
  });

  app.get("/api/docs/:id", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const d = DOCS.find((x) => x.id === (req.params as { id: string }).id);
    if (!d || !canRead(d, u)) return reply.code(403).send({ error: "you do not have access to this document" });
    return { doc: d };
  });

  // --- The vulnerable handler: the share is found by id; the recipient is never compared. ---
  app.post("/api/shares/:id/accept", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const s = shares.find((x) => x.id === (req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: "no such share" });
    if (s.acceptedBy) return reply.code(409).send({ error: "this share was already accepted" });
    s.acceptedBy = u.username;
    if (!access.has(s.docId)) access.set(s.docId, new Set());
    access.get(s.docId)!.add(u.username);
    if (s.recipientEmail !== u.email) {
      const doc = DOCS.find((d) => d.id === s.docId)!;
      await reportSolve(ctx, `"${u.username}" (${u.email}) accepted share ${s.id} that was addressed to ${s.recipientEmail} and gained access to "${doc.name}"`);
    }
    return { accepted: s.id, docId: s.docId };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[docly] fatal error:", err);
  process.exit(1);
});
