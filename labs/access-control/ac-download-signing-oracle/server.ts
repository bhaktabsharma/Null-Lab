/**
 * Vaultbox — Share a File (download-link signing oracle)
 *
 * Downloading a file directly is protected correctly: only the owner. Sharing is
 * done with signed, expiring links, and the link is signed with the server's
 * secret — the signing endpoint, though, only checks that the file EXISTS. It
 * will sign a link for any file id, and the signed link needs no session at all.
 * Recorded only when a signed link whose signer does not own the file is
 * actually used to download it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Vaultbox";

interface User {
  username: string;
  password: string;
  displayName: string;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "tess", password: "Owner-Vault!61", displayName: "Tess Duarte" },
];
interface VFile {
  id: string;
  name: string;
  owner: string;
  body: string;
}
const FILES: VFile[] = [
  { id: "f-1001", name: "Lease-agreement.txt", owner: "alice", body: "SYNTHETIC lease agreement — tenant: Alice Chen, term 12 months." },
  { id: "f-1002", name: "Holiday-plans.txt", owner: "alice", body: "SYNTHETIC holiday plan — flights booked for the first week of June." },
  { id: "f-2001", name: "Board-minutes-Q3.txt", owner: "tess", body: "SYNTHETIC CONFIDENTIAL board minutes Q3 — acquisition target shortlist: ORCHID, BASALT." },
  { id: "f-2002", name: "Salary-bands.txt", owner: "tess", body: "SYNTHETIC CONFIDENTIAL salary bands — L5: 118k, L6: 141k, L7: 168k." },
];

const sessions = makeSessions<{ user: string }>(ctx, "vaultbox_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#50fa7b",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/files", label: "My files" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const sign = (id: string, signer: string, exp: number) => createHmac("sha256", ctx.instanceToken).update(`${id}|${signer}|${exp}`).digest("hex").slice(0, 32);

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const data = await (await fetch("/api/files")).json();
  document.getElementById("rows").innerHTML = data.files.map(function (f) {
    return "<tr><td>" + esc(f.name) + "</td><td>" + esc(f.id) + '</td><td><button onclick="share(\\'' + f.id + '\\')">Get share link</button></td></tr>';
  }).join("");
}
async function share(id) {
  const res = await fetch("/api/files/" + id + "/share-link", { method: "POST" });
  const data = await res.json();
  document.getElementById("link").textContent = res.ok ? location.origin + data.url : data.error;
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/files", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/files" : "/login"));

  app.get("/files", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "My files",
      `<div class="panel"><h1>My files</h1>
        <table><tr><th>Name</th><th>Id</th><th></th></tr><tbody id="rows"></tbody></table>
        <p class="muted">Share link: <code id="link"></code></p></div>
      <script>${PAGE_SCRIPT}</script>`,
      USERS.find((x) => x.username === u)?.displayName,
    );
  });

  app.get("/api/files", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { files: FILES.filter((f) => f.owner === u).map((f) => ({ id: f.id, name: f.name })) };
  });

  // Correctly protected: only the owner can download directly.
  app.get("/api/files/:id/download", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const f = FILES.find((x) => x.id === (req.params as { id: string }).id);
    if (!f) return reply.code(404).send({ error: "no such file" });
    if (f.owner !== u) return reply.code(403).send({ error: "you do not own this file" });
    reply.type("text/plain");
    return f.body;
  });

  // --- The vulnerable handler: signs a link for any file that exists. ---------------
  app.post("/api/files/:id/share-link", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const f = FILES.find((x) => x.id === (req.params as { id: string }).id);
    if (!f) return reply.code(404).send({ error: "no such file" });
    const exp = Math.floor(Date.now() / 1000) + 600;
    return { url: `/dl/${f.id}?u=${encodeURIComponent(u)}&exp=${exp}&sig=${sign(f.id, u, exp)}`, expiresInSeconds: 600 };
  });

  // Signed links need no session.
  app.get("/dl/:id", async (req, reply) => {
    const q = req.query as { u?: string; exp?: string; sig?: string };
    const id = (req.params as { id: string }).id;
    const exp = Number(q.exp);
    if (!q.u || !q.sig || !Number.isFinite(exp)) return reply.code(400).send({ error: "malformed link" });
    const expected = Buffer.from(sign(id, q.u, exp));
    const given = Buffer.from(String(q.sig));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return reply.code(403).send({ error: "bad signature" });
    if (exp < Date.now() / 1000) return reply.code(410).send({ error: "link expired" });
    const f = FILES.find((x) => x.id === id);
    if (!f) return reply.code(404).send({ error: "no such file" });
    if (f.owner !== q.u) {
      await reportSolve(ctx, `a download link signed on behalf of "${q.u}" served file ${f.id} ("${f.name}"), which belongs to "${f.owner}"`);
    }
    reply.type("text/plain");
    return f.body;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[vaultbox] fatal error:", err);
  process.exit(1);
});
