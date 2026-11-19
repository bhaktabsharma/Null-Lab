/**
 * SearchPortal — Login SQL Injection Bypass
 *
 * POST /login checks credentials with a raw, string-concatenated query:
 *
 *   SELECT id, username, password, role FROM accounts
 *   WHERE username = '${username}' AND password = '${password}'
 *
 * The solve condition is evaluated honestly against the REAL matched row
 * from the REAL database: if the query returned an admin account, but the
 * password the client actually submitted does not equal that account's
 * real stored password, the only way the WHERE clause could have matched
 * is injected SQL logic (comment truncation, `OR` tautologies, etc.) —
 * regardless of which specific injection technique was used.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  openInstanceDb,
  renderShell,
  escapeHtml,
  signSession,
  verifySession,
  parseCookies,
} from "@nulllab/lab-sdk";
import { createHash } from "node:crypto";

const ctx = loadLabContext();
const db = openInstanceDb(ctx);
const SESSION_COOKIE = "searchportal_session";

db.exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, username TEXT, password TEXT, role TEXT);`);

// A different, non-guessable admin password per instance — the point of
// the lab is that you never need to know it.
const ADMIN_PASSWORD = createHash("sha256").update(ctx.instanceToken).digest("hex").slice(0, 20);

db.prepare("INSERT INTO accounts (username, password, role) VALUES (?, ?, ?)").run("dana", "practice123", "customer");
db.prepare("INSERT INTO accounts (username, password, role) VALUES (?, ?, ?)").run("admin", ADMIN_PASSWORD, "admin");

function getSession(cookieHeader: string | undefined): { user: string; role: string } | null {
  return verifySession<{ user: string; role: string }>(ctx.instanceToken, parseCookies(cookieHeader)[SESSION_COOKIE]);
}

function shell(title: string, body: string, user?: string) {
  return renderShell(title, body, {
    appName: "SearchPortal",
    accent: "#c97fd1",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/account", label: "My Account" }, { href: "/logout", label: "Log out" }] : [{ href: "/", label: "Log in" }],
  });
}

async function main() {
  const app = await createLabApp(ctx, { appName: "SearchPortal" });

  app.get("/", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    if (session) return reply.redirect("/account");
    const err = (req.query as any)?.error;
    reply.type("text/html");
    return shell(
      "Sign in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;">
        <h1>Sign in to SearchPortal</h1>
        ${err ? `<p class="muted" style="color:#e07a7a;">Login failed.</p>` : ""}
        <form method="post" action="/login">
          <p><input type="text" name="username" placeholder="Username" /></p>
          <p><input type="password" name="password" placeholder="Password" /></p>
          <button type="submit">Sign in</button>
        </form>
        <p class="muted" style="margin-top:1rem;">Demo account: <strong>dana</strong> / practice123</p>
      </div>`,
    );
  });

  // --- The vulnerable handler -------------------------------------------------
  app.post("/login", async (req, reply) => {
    const body = req.body as { username?: string; password?: string };
    const username = body.username ?? "";
    const password = body.password ?? "";

    // VULNERABLE: raw string concatenation, no parameter binding.
    const sql = `SELECT id, username, password, role FROM accounts WHERE username = '${username}' AND password = '${password}'`;

    let row: { id: number; username: string; password: string; role: string } | undefined;
    let queryError: string | null = null;
    try {
      row = db.prepare(sql).get() as typeof row;
    } catch (err) {
      queryError = (err as Error).message;
    }

    if (!row) {
      reply.type("text/html");
      if (queryError) {
        return shell(
          "Sign in",
          `<div class="panel" style="max-width:500px;margin:3rem auto;">
            <h1>Sign in to SearchPortal</h1>
            <p class="muted" style="color:#e07a7a;">Database error: ${escapeHtml(queryError)}</p>
            <p><a class="link" href="/">&larr; Try again</a></p>
          </div>`,
        );
      }
      return reply.redirect("/?error=1");
    }

    // Honest, server-side proof: the matched row is real, but if the
    // submitted password doesn't equal that row's real stored password,
    // the match could only have happened through injected SQL logic.
    if (row.role === "admin" && password !== row.password) {
      await reportSolve(
        ctx,
        `POST /login authenticated as admin account (id ${row.id}) using submitted password "${password}" which does not match the account's real stored password — query: ${sql}`,
      );
    }

    reply.setCookie(SESSION_COOKIE, signSession(ctx.instanceToken, { user: row.username, role: row.role }), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    return reply.redirect("/account");
  });

  app.get("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.redirect("/");
  });

  app.get("/account", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    if (!session) return reply.redirect("/");
    reply.type("text/html");
    return shell(
      "My Account",
      `<div class="panel">
        <h1>Account</h1>
        <table>
          <tr><th>Username</th><td>${escapeHtml(session.user)}</td></tr>
          <tr><th>Role</th><td><span class="pill">${escapeHtml(session.role)}</span></td></tr>
        </table>
        ${session.role === "admin" ? `<p class="muted" style="margin-top:1rem;">This account can manage every customer's orders and data.</p>` : ""}
      </div>`,
      session.user,
    );
  });

  await startLabApp(app, ctx, "SearchPortal");
}

main().catch((err) => {
  console.error("[searchportal-login] fatal error:", err);
  process.exit(1);
});
