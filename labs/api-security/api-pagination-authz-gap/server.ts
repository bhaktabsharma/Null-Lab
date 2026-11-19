/**
 * TicketsAPI — Page Through Everything (pagination/filtering authorization gap)
 *
 * The underlying ticket list interleaves every user's tickets. The handler
 * takes a PAGE (limit/offset slice) of that full list FIRST, then filters
 * the page down to the caller's own tickets — so a page landing mostly on
 * someone else's tickets returns their data instead of an empty/short page
 * of the caller's own. The correct order (filter by owner, THEN paginate)
 * would never do this. Recorded only when a returned ticket's owner differs
 * from the caller.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, makeSessions, registerPasswordLogin, renderShell } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "TicketsAPI";
interface User { username: string; password: string; displayName: string; }
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "bob", password: "hunter22", displayName: "Bob Okafor" },
];
const sessions = makeSessions<{ user: string }>(ctx, "ta_session");

// Ordered by creation time: alice signed up and filed her tickets first, so
// the default-sized page lands entirely within her own tickets — correctly,
// for the wrong reason (contiguous luck, not real filtering). A larger page
// reaches into bob's tickets right after hers in the same underlying list.
const ALL_TICKETS = [
  { id: 1, owner: "alice", subject: "Printer offline" },
  { id: 2, owner: "alice", subject: "Extra monitor request" },
  { id: 3, owner: "bob", subject: "VPN cert expiring" },
  { id: 4, owner: "bob", subject: "Suspected phishing email — do not forward" },
];

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#d87fc9", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/", async (req, reply) => {
    const u = viewer(req);
    reply.type("text/html");
    return shell("TicketsAPI", `<div class="panel"><h1>TicketsAPI</h1><p class="muted">GET /api/tickets?limit=&amp;offset=</p></div>`, u?.displayName);
  });

  // --- The vulnerable handler: pages BEFORE filtering by owner. ----------------
  app.get("/api/tickets", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 2));
    const offset = Math.max(0, Number(q.offset) || 0);

    const page = ALL_TICKETS.slice(offset, offset + limit); // VULNERABLE: slice first...
    const visible = page.filter((t) => t.owner === u.username); // ...filter second, too late

    const foreign = page.filter((t) => t.owner !== u.username);
    if (foreign.length > 0) {
      await reportSolve(ctx, `GET /api/tickets?limit=${limit}&offset=${offset} returned ticket(s) owned by ${[...new Set(foreign.map((t) => t.owner))].join(", ")} to signed-in user "${u.username}"`);
      return { tickets: page, limit, offset }; // the actual (buggy) response a learner would see
    }
    return { tickets: visible, limit, offset };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[ticketsapi] fatal error:", err);
  process.exit(1);
});
