/**
 * SupportDesk — Private Ticket Leak (IDOR)
 *
 * A help-desk app with sequential ticket IDs. GET /tickets/:id renders a
 * ticket thread without checking the requester owns it — a third,
 * differently-shaped IDOR scenario (different app, different object model,
 * different business context) from the two ShopMart labs.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  escapeHtml,
  signSession,
  verifySession,
  parseCookies,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const SESSION_COOKIE = "supportdesk_session";

interface User {
  username: string;
  password: string;
  displayName: string;
}
interface Ticket {
  id: number;
  owner: string;
  subject: string;
  status: string;
  messages: { from: string; body: string }[];
}

const USERS: User[] = [
  { username: "priya", password: "practice123", displayName: "Priya Nair" },
  { username: "marcus", password: "fallback99", displayName: "Marcus Webb" },
];

const TICKETS: Ticket[] = [
  {
    id: 7001,
    owner: "priya",
    subject: "Can't reset my password",
    status: "Open",
    messages: [
      { from: "priya", body: "The reset link in the email never arrives. Can someone help?" },
      { from: "support-agent", body: "Hi Priya — resending now, should land within a few minutes." },
    ],
  },
  {
    id: 7002,
    owner: "marcus",
    subject: "Billing question — duplicate charge",
    status: "Open",
    messages: [
      { from: "marcus", body: "I was charged twice this month on the card ending 4417. Refund the duplicate please." },
      { from: "support-agent", body: "Apologies for that! I can confirm the duplicate and I'm processing a refund now." },
    ],
  },
  {
    id: 7003,
    owner: "marcus",
    subject: "Feature request: dark mode",
    status: "Closed",
    messages: [{ from: "marcus", body: "Any plans to add a dark theme to the dashboard?" }],
  },
];

function getSession(cookieHeader: string | undefined): { user: string } | null {
  return verifySession<{ user: string }>(ctx.instanceToken, parseCookies(cookieHeader)[SESSION_COOKIE]);
}

function shell(title: string, body: string, user?: string) {
  return renderShell(title, body, {
    appName: "SupportDesk",
    accent: "#e0a63f",
    currentUserLabel: user ?? null,
    navLinks: user
      ? [
          { href: "/dashboard", label: "Dashboard" },
          { href: "/tickets", label: "My Tickets" },
          { href: "/logout", label: "Log out" },
        ]
      : [{ href: "/login", label: "Log in" }],
  });
}

async function main() {
  const app = await createLabApp(ctx, { appName: "SupportDesk" });

  app.get("/", async (req, reply) => reply.redirect(getSession(req.headers.cookie) ? "/dashboard" : "/login"));

  app.get("/login", async (req, reply) => {
    const err = (req.query as any)?.error;
    reply.type("text/html");
    return shell(
      "Sign in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;">
        <h1>Sign in to SupportDesk</h1>
        ${err ? `<p class="muted" style="color:#e07a7a;">Incorrect username or password.</p>` : ""}
        <form method="post" action="/login">
          <p><input type="text" name="username" placeholder="Username" /></p>
          <p><input type="password" name="password" placeholder="Password" /></p>
          <button type="submit">Sign in</button>
        </form>
        <p class="muted" style="margin-top:1rem;">Demo account: <strong>priya</strong> / practice123</p>
      </div>`,
    );
  });

  app.post("/login", async (req, reply) => {
    const body = req.body as { username?: string; password?: string };
    const user = USERS.find((u) => u.username === body.username && u.password === body.password);
    if (!user) return reply.redirect("/login?error=1");
    reply.setCookie(SESSION_COOKIE, signSession(ctx.instanceToken, { user: user.username }), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    return reply.redirect("/dashboard");
  });

  app.get("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.redirect("/login");
  });

  app.get("/dashboard", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    if (!session) return reply.redirect("/login");
    const user = USERS.find((u) => u.username === session.user)!;
    reply.type("text/html");
    return shell(
      "Dashboard",
      `<div class="panel">
        <h1>Welcome back, ${escapeHtml(user.displayName)}</h1>
        <p class="muted">Open a new ticket or check the status of an existing one.</p>
        <p><a class="btn" href="/tickets">View my tickets</a></p>
      </div>`,
      user.displayName,
    );
  });

  app.get("/tickets", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    if (!session) return reply.redirect("/login");
    const mine = TICKETS.filter((t) => t.owner === session.user);
    reply.type("text/html");
    return shell(
      "My Tickets",
      `<div class="panel">
        <h1>My Tickets</h1>
        <table>
          <tr><th>Ticket #</th><th>Subject</th><th>Status</th><th></th></tr>
          ${mine
            .map(
              (t) => `<tr>
                <td>#${t.id}</td><td>${escapeHtml(t.subject)}</td><td><span class="pill">${escapeHtml(t.status)}</span></td>
                <td><a class="link" href="/tickets/${t.id}">Open</a></td>
              </tr>`,
            )
            .join("")}
        </table>
      </div>`,
      session.user,
    );
  });

  // --- The vulnerable handler -------------------------------------------------
  app.get("/tickets/:id", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    if (!session) return reply.redirect("/login");

    const id = Number((req.params as { id: string }).id);
    const ticket = TICKETS.find((t) => t.id === id);
    if (!ticket) {
      reply.code(404);
      reply.type("text/html");
      return shell("Not found", `<div class="panel"><h1>Ticket not found</h1></div>`, session.user);
    }

    if (ticket.owner !== session.user) {
      await reportSolve(
        ctx,
        `session user "${session.user}" retrieved ticket #${ticket.id} (subject "${ticket.subject}") owned by "${ticket.owner}" via GET /tickets/${ticket.id}`,
      );
    }

    reply.type("text/html");
    return shell(
      `Ticket #${ticket.id}`,
      `<div class="panel">
        <h1>#${ticket.id} — ${escapeHtml(ticket.subject)}</h1>
        <p class="muted">Opened by ${escapeHtml(ticket.owner)} &middot; <span class="pill">${escapeHtml(ticket.status)}</span></p>
        ${ticket.messages
          .map(
            (m) => `<div class="panel" style="background:#0b0e13;margin-bottom:0.6rem;">
              <strong>${escapeHtml(m.from)}</strong>
              <p style="margin:0.3rem 0 0;">${escapeHtml(m.body)}</p>
            </div>`,
          )
          .join("")}
        <p><a class="link" href="/tickets">&larr; Back to my tickets</a></p>
      </div>`,
      session.user,
    );
  });

  await startLabApp(app, ctx, "SupportDesk");
}

main().catch((err) => {
  console.error("[supportdesk] fatal error:", err);
  process.exit(1);
});
