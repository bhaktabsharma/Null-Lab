/**
 * ShopMart — Invoice Leak (IDOR)
 *
 * A small online store. Customers can view their own purchase invoices at
 * GET /invoices/:id. The handler below fetches an invoice by id and renders
 * it WITHOUT checking that the invoice belongs to the signed-in customer —
 * a textbook insecure direct object reference. The solve condition is
 * reported from inside that exact handler, at the exact moment the server
 * has honestly determined the invariant was broken (owner !== session
 * user) — never from a client-supplied flag.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, signSession, verifySession, parseCookies } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const SESSION_COOKIE = "shopmart_session";

interface User {
  username: string;
  password: string;
  displayName: string;
}
interface Invoice {
  id: number;
  owner: string;
  item: string;
  amount: string;
  date: string;
}

const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "bob", password: "hunter22", displayName: "Bob Okafor" },
];

const INVOICES: Invoice[] = [
  { id: 1001, owner: "alice", item: "Mechanical Keyboard (TKL, brown switches)", amount: "$129.99", date: "2026-09-14" },
  { id: 1002, owner: "bob", item: "Ergonomic Office Chair — Premium", amount: "$899.00", date: "2026-09-02" },
  { id: 1003, owner: "bob", item: "27in 4K Monitor", amount: "$412.50", date: "2026-10-01" },
];

function getSession(cookieHeader: string | undefined): { user: string } | null {
  const cookies = parseCookies(cookieHeader);
  return verifySession<{ user: string }>(ctx.instanceToken, cookies[SESSION_COOKIE]);
}

function shell(title: string, body: string, user?: string) {
  return renderShell(title, body, {
    appName: "ShopMart",
    accent: "#3fb8af",
    currentUserLabel: user ?? null,
    navLinks: user
      ? [
          { href: "/dashboard", label: "Dashboard" },
          { href: "/invoices", label: "My Invoices" },
          { href: "/logout", label: "Log out" },
        ]
      : [{ href: "/login", label: "Log in" }],
  });
}

async function main() {
  const app = await createLabApp(ctx, { appName: "ShopMart" });

  app.get("/", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    return reply.redirect(session ? "/dashboard" : "/login");
  });

  app.get("/login", async (req, reply) => {
    const err = (req.query as any)?.error;
    reply.type("text/html");
    return shell(
      "Sign in",
      `
      <div class="panel" style="max-width:380px;margin:3rem auto;">
        <h1>Sign in to ShopMart</h1>
        ${err ? `<p class="muted" style="color:#e07a7a;">Incorrect username or password.</p>` : ""}
        <form method="post" action="/login">
          <p><input type="text" name="username" placeholder="Username" autocomplete="username" /></p>
          <p><input type="password" name="password" placeholder="Password" autocomplete="current-password" /></p>
          <button type="submit">Sign in</button>
        </form>
        <p class="muted" style="margin-top:1rem;">Demo account: <strong>alice</strong> / practice123</p>
      </div>`,
    );
  });

  app.post("/login", async (req, reply) => {
    const body = req.body as { username?: string; password?: string };
    const user = USERS.find((u) => u.username === body.username && u.password === body.password);
    if (!user) return reply.redirect("/login?error=1");
    const token = signSession(ctx.instanceToken, { user: user.username });
    reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax" });
    return reply.redirect("/dashboard");
  });

  app.get("/logout", async (req, reply) => {
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
      `
      <div class="panel">
        <h1>Welcome back, ${escapeHtml(user.displayName)}</h1>
        <p class="muted">From here you can review your past purchases and invoices.</p>
        <p><a class="btn" href="/invoices">View my invoices</a></p>
      </div>`,
      user.displayName,
    );
  });

  app.get("/invoices", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    if (!session) return reply.redirect("/login");
    const mine = INVOICES.filter((i) => i.owner === session.user);
    reply.type("text/html");
    return shell(
      "My Invoices",
      `
      <div class="panel">
        <h1>My Invoices</h1>
        <table>
          <tr><th>Invoice #</th><th>Date</th><th>Item</th><th>Amount</th><th></th></tr>
          ${mine
            .map(
              (i) => `<tr>
                <td>#${i.id}</td><td>${escapeHtml(i.date)}</td><td>${escapeHtml(i.item)}</td><td>${escapeHtml(i.amount)}</td>
                <td><a class="link" href="/invoices/${i.id}">View</a></td>
              </tr>`,
            )
            .join("")}
        </table>
      </div>`,
      session.user,
    );
  });

  // --- The vulnerable handler -------------------------------------------------
  app.get("/invoices/:id", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    if (!session) return reply.redirect("/login");

    const id = Number((req.params as { id: string }).id);
    const invoice = INVOICES.find((i) => i.id === id);
    if (!invoice) {
      reply.code(404);
      reply.type("text/html");
      return shell("Not found", `<div class="panel"><h1>Invoice not found</h1></div>`, session.user);
    }

    // VULNERABLE: no check that invoice.owner === session.user before
    // returning the full invoice. This is the real, honestly-evaluated
    // condition the lab reports on — not a hardcoded "if id === X" trick.
    if (invoice.owner !== session.user) {
      await reportSolve(
        ctx,
        `session user "${session.user}" retrieved invoice #${invoice.id} owned by "${invoice.owner}" via GET /invoices/${invoice.id}`,
      );
    }

    reply.type("text/html");
    return shell(
      `Invoice #${invoice.id}`,
      `
      <div class="panel">
        <h1>Invoice #${invoice.id}</h1>
        <table>
          <tr><th>Billed to</th><td>${escapeHtml(invoice.owner)}</td></tr>
          <tr><th>Date</th><td>${escapeHtml(invoice.date)}</td></tr>
          <tr><th>Item</th><td>${escapeHtml(invoice.item)}</td></tr>
          <tr><th>Amount</th><td>${escapeHtml(invoice.amount)}</td></tr>
        </table>
        <p><a class="link" href="/invoices">&larr; Back to my invoices</a></p>
      </div>`,
      session.user,
    );
  });

  await startLabApp(app, ctx, "ShopMart");
}

main().catch((err) => {
  console.error("[shopmart] fatal error:", err);
  process.exit(1);
});
