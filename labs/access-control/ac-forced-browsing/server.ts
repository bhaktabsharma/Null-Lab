/**
 * Halden Staff Portal — Unlinked Admin Tools (forced browsing)
 *
 * The admin tools area is "protected" only by not being linked anywhere. Its
 * index and the payroll export have no authorization check at all. The solve
 * is recorded only when the payroll export itself is served to someone who is
 * not an administrator — merely finding the index page proves nothing.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  escapeHtml,
  makeSessions,
  registerPasswordLogin,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Halden Staff Portal";
const TOOLS = "/staff-tools-4821";

interface User {
  username: string;
  password: string;
  displayName: string;
  role: "staff" | "admin";
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", role: "staff" },
  { username: "ops-admin", password: "Adm1n-Only!2024", displayName: "Ops Admin", role: "admin" },
];
const PAYROLL = [
  { employee: "Alice Chen", department: "Support", monthly: "3,850.00" },
  { employee: "Marcus Webb", department: "Engineering", monthly: "6,420.00" },
  { employee: "Priya Nair", department: "Finance", monthly: "5,975.00" },
  { employee: "Tomás Rivera", department: "Operations", monthly: "4,310.00" },
];

const sessions = makeSessions<{ user: string }>(ctx, "halden_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#8fa8ff",
    currentUserLabel: user ?? null,
    navLinks: [
      { href: "/", label: "News" },
      user ? { href: "/logout", label: "Log out" } : { href: "/login", label: "Staff login" },
    ],
  });
}

function viewer(req: Parameters<typeof sessions.read>[0]): User | null {
  const s = sessions.read(req);
  return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  registerPasswordLogin(app, {
    users: USERS,
    sessions,
    shell,
    appName: APP,
    home: "/",
    demoLine: "Staff demo account: <strong>alice</strong> / practice123",
  });

  app.get("/", async (req, reply) => {
    const u = viewer(req);
    reply.type("text/html");
    return shell(
      "News",
      `<div class="panel">
        <h1>Halden Staff Portal</h1>
        <p class="muted">Company news and announcements.</p>
        <ul>
          <li>Q3 all-hands moved to Thursday, 10:00 in the Atrium.</li>
          <li>Reminder: expense reports are due on the 25th.</li>
          <li>The new visitor badge system goes live next week.</li>
        </ul>
      </div>`,
      u?.displayName,
    );
  });

  // The kind of file crawlers (and curious people) read first.
  app.get("/robots.txt", async (_req, reply) => {
    reply.type("text/plain");
    return `User-agent: *\nDisallow: ${TOOLS}/\n`;
  });

  // --- The flaw: nothing below checks who is asking. -------------------------
  const toolsIndex = async (_req: unknown, reply: { type: (t: string) => unknown }) => {
    reply.type("text/html");
    return shell(
      "Internal tools",
      `<div class="panel">
        <h1>Internal tools</h1>
        <p class="muted">Operations use only.</p>
        <ul>
          <li><a class="link" href="${TOOLS}/payroll-export">Payroll export (CSV)</a></li>
          <li><span class="muted">Badge reprint queue — coming soon</span></li>
        </ul>
      </div>`,
    );
  };
  app.get(TOOLS, toolsIndex);
  app.get(`${TOOLS}/`, toolsIndex);

  app.get(`${TOOLS}/payroll-export`, async (req, reply) => {
    const u = viewer(req);
    if (!u || u.role !== "admin") {
      await reportSolve(
        ctx,
        `GET ${TOOLS}/payroll-export was served to ${u ? `non-admin session "${u.username}"` : "a request with no session"} (no authorization check)`,
      );
    }
    reply.type("text/csv");
    return ["employee,department,monthly_gross", ...PAYROLL.map((p) => `${escapeHtml(p.employee)},${p.department},${p.monthly}`)].join("\n") + "\n";
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[halden-portal] fatal error:", err);
  process.exit(1);
});
