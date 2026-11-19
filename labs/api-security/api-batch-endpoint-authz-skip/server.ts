/**
 * Deskline — Support Tickets (batch endpoint skips the per-item ownership check)
 *
 * Updating a single ticket is correctly scoped: PATCH /api/tickets/:id checks
 * that the ticket belongs to the caller. A bulk-update endpoint was added for
 * convenience ("close all your resolved tickets at once") and updates every
 * ticket id it is given in one pass — checking that each id EXISTS, but never
 * that it belongs to the caller. Recorded only when a batch update actually
 * changes a ticket that belongs to a different user.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Deskline";
const STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
type Status = (typeof STATUSES)[number];

const USERS = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "dana", password: "Dana-Deskline!81", displayName: "Dana Whitfield" },
];
interface Ticket {
  id: string;
  owner: string;
  subject: string;
  status: Status;
}
const tickets: Ticket[] = [
  { id: "t-1", owner: "alice", subject: "Can't export my report", status: "resolved" },
  { id: "t-2", owner: "alice", subject: "Billing question", status: "open" },
  { id: "t-3", owner: "dana", subject: "Password reset is not arriving — urgent, escalate to tier 2", status: "in_progress" },
];

const sessions = makeSessions<{ user: string }>(ctx, "deskline_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#8be9fd",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/tickets", label: "My tickets" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
async function load() {
  const d = await (await fetch("/api/tickets")).json();
  document.getElementById("rows").innerHTML = d.tickets.map(function (t) { return "<tr><td>" + t.id + "</td><td>" + t.subject + "</td><td>" + t.status + "</td></tr>"; }).join("");
}
async function closeResolved() {
  const d = await (await fetch("/api/tickets")).json();
  const ids = d.tickets.filter(function (t) { return t.status === "resolved"; }).map(function (t) { return t.id; });
  await fetch("/api/tickets/batch-update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ids, status: "closed" }) });
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/tickets", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/tickets" : "/login"));

  app.get("/tickets", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("My tickets", `<div class="panel"><h1>My tickets</h1>
      <table><tr><th>Id</th><th>Subject</th><th>Status</th></tr><tbody id="rows"></tbody></table>
      <p><button onclick="closeResolved()">Close all my resolved tickets</button></p></div><script>${PAGE_SCRIPT}</script>`, "Alice Chen");
  });

  app.get("/api/tickets", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { tickets: tickets.filter((t) => t.owner === u) };
  });

  const isStatus = (s: unknown): s is Status => typeof s === "string" && (STATUSES as readonly string[]).includes(s);

  // Correctly scoped: a single update checks ownership.
  app.patch("/api/tickets/:id", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const tkt = tickets.find((t) => t.id === (req.params as { id: string }).id);
    if (!tkt) return reply.code(404).send({ error: "no such ticket" });
    if (tkt.owner !== u) return reply.code(403).send({ error: "this is not your ticket" });
    const status = (req.body as { status?: unknown } | undefined)?.status;
    if (!isStatus(status)) return reply.code(400).send({ error: "unknown status" });
    tkt.status = status;
    return { ticket: tkt };
  });

  // --- The vulnerable handler: ids are checked for EXISTENCE, never for OWNERSHIP. --------
  app.post("/api/tickets/batch-update", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const body = (req.body ?? {}) as { ids?: unknown; status?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 20 || !body.ids.every((x) => typeof x === "string")) {
      return reply.code(400).send({ error: "ids must be a non-empty array of up to 20 strings" });
    }
    if (!isStatus(body.status)) return reply.code(400).send({ error: "unknown status" });
    const updated: Ticket[] = [];
    const foreignUpdates: Ticket[] = [];
    for (const id of body.ids as string[]) {
      const tkt = tickets.find((t) => t.id === id);
      if (!tkt) continue; // exists? checked. owned by the caller? never checked.
      tkt.status = body.status;
      updated.push(tkt);
      if (tkt.owner !== u) foreignUpdates.push(tkt);
    }
    if (foreignUpdates.length > 0) {
      await reportSolve(ctx, `"${u}" batch-updated ${foreignUpdates.map((t) => `${t.id} (owner "${t.owner}")`).join(", ")} to status "${body.status}" through /api/tickets/batch-update`);
    }
    return { updated: updated.map((t) => t.id) };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[deskline] fatal error:", err);
  process.exit(1);
});
