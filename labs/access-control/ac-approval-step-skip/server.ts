/**
 * Spendly — Purchase Approvals (multi-step approval bypass)
 *
 * Purchases over the threshold need two approvals in order: the line manager,
 * then finance. The manager step checks the caller's role correctly. The
 * finance step only checks that the caller is "an approver" (manager OR
 * finance), so a manager can record the finance approval too and trigger the
 * payout. Requesters can't approve, nobody approves their own request, and the
 * finance step does require a prior manager approval. Recorded only when a
 * payout is released on a finance approval recorded by a non-finance user.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Spendly";

type Role = "requester" | "manager" | "finance";
interface User {
  username: string;
  password: string;
  displayName: string;
  role: Role;
}
const USERS: User[] = [
  { username: "mia", password: "Mgr-Spendly!91", displayName: "Mia Okonkwo", role: "manager" },
  { username: "fred", password: "Fin-Spendly!92", displayName: "Fred Lindqvist", role: "finance" },
  { username: "alice", password: "practice123", displayName: "Alice Chen", role: "requester" },
];

interface Req {
  id: string;
  title: string;
  amount: number;
  requester: string;
  status: "submitted" | "manager-approved" | "paid";
  managerApprovedBy?: string;
  financeApprovedBy?: string;
}
let nextId = 3;
const requests: Req[] = [
  { id: "r1", title: "Conference travel — Lisbon", amount: 4200, requester: "alice", status: "submitted" },
  { id: "r2", title: "Team offsite venue deposit", amount: 6800, requester: "alice", status: "manager-approved", managerApprovedBy: "mia" },
];

const sessions = makeSessions<{ user: string }>(ctx, "spendly_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#ff5555",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/requests", label: "Requests" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const me = await (await fetch("/api/me")).json();
  const data = await (await fetch("/api/requests")).json();
  document.getElementById("rows").innerHTML = data.requests.map(function (r) {
    let act = "";
    if (me.role === "manager" && r.status === "submitted") act = '<button onclick="approve(\\'' + r.id + '\\', \\'manager\\')">Approve (manager)</button>';
    if (me.role === "finance" && r.status === "manager-approved") act = '<button onclick="approve(\\'' + r.id + '\\', \\'finance\\')">Approve and pay</button>';
    return "<tr><td>" + esc(r.id) + "</td><td>" + esc(r.title) + "</td><td>" + esc(r.requester) + "</td><td>$" + esc(r.amount) + "</td><td>" + esc(r.status) + "</td><td>" + act + "</td></tr>";
  }).join("");
}
async function approve(id, step) {
  const r = await fetch("/api/requests/" + id + "/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step: step }) });
  if (!r.ok) alert((await r.json()).error);
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

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/requests", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(viewer(req) ? "/requests" : "/login"));

  app.get("/requests", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Requests",
      `<div class="panel"><h1>Purchase requests</h1>
        <table><tr><th>Id</th><th>Request</th><th>By</th><th>Amount</th><th>Status</th><th></th></tr><tbody id="rows"></tbody></table></div>
      <script>${PAGE_SCRIPT}</script>`,
      u.displayName,
    );
  });

  app.get("/api/me", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { username: u.username, role: u.role };
  });

  app.get("/api/requests", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { requests: u.role === "requester" ? requests.filter((r) => r.requester === u.username) : requests };
  });

  app.post("/api/requests", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const b = (req.body ?? {}) as { title?: unknown; amount?: unknown };
    if (typeof b.title !== "string" || b.title.length === 0 || b.title.length > 80) return reply.code(400).send({ error: "title is required" });
    if (typeof b.amount !== "number" || !(b.amount > 0) || b.amount > 100000) return reply.code(400).send({ error: "amount must be between 0 and 100000" });
    const r: Req = { id: `r${nextId++}`, title: b.title, amount: b.amount, requester: u.username, status: "submitted" };
    requests.push(r);
    return { request: r };
  });

  app.post("/api/requests/:id/approve", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    // Anyone who is not a plain requester counts as "an approver".
    if (u.role === "requester") return reply.code(403).send({ error: "only approvers can approve requests" });
    const r = requests.find((x) => x.id === (req.params as { id: string }).id);
    if (!r) return reply.code(404).send({ error: "no such request" });
    if (r.requester === u.username) return reply.code(403).send({ error: "you cannot approve your own request" });
    const step = ((req.body ?? {}) as { step?: unknown }).step;

    if (step === "manager") {
      if (u.role !== "manager") return reply.code(403).send({ error: "this step needs a manager" }); // correct
      if (r.status !== "submitted") return reply.code(409).send({ error: `request is already ${r.status}` });
      r.status = "manager-approved";
      r.managerApprovedBy = u.username;
      return { request: r };
    }
    if (step === "finance") {
      // Order is enforced, but the role of whoever records the finance approval is not.
      if (r.status === "submitted") return reply.code(409).send({ error: "the manager must approve first" });
      if (r.status === "paid") return reply.code(409).send({ error: "already paid" });
      r.financeApprovedBy = u.username;
      r.status = "paid"; // approval releases the payout
      if (u.role !== "finance") {
        await reportSolve(ctx, `"${u.username}" (role "${u.role}") recorded the finance approval on ${r.id} ("${r.title}", $${r.amount}) and the payout was released`);
      }
      return { request: r };
    }
    return reply.code(400).send({ error: 'step must be "manager" or "finance"' });
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[spendly] fatal error:", err);
  process.exit(1);
});
