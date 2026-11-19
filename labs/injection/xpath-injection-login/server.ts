/**
 * ArchiveBox — XPath Login (XPath injection)
 *
 * Accounts live in an in-memory XML document and login runs
 * `//user[username='<u>' and password='<p>']` through the real xpath engine
 * with the input concatenated in. The XML is a trusted string the lab builds
 * itself (no DTD/entity handling of learner input, no files, no network): only
 * the XPath expression is attacker-influenced. The application signs in as the
 * FIRST matched user. Recorded only when 'admin' is signed in with a password
 * that is not its real one.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, makeSessions, seededSecret, parseXml, xpathElements, childText } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "ArchiveBox";
const ADMIN_PASSWORD = seededSecret(ctx, "admin-password", 14);
const sessions = makeSessions<{ user: string }>(ctx, "ab_session");

// Admin is deliberately LAST, so a naive always-true condition returns alice, not admin.
const doc = parseXml(
  `<users>
    <user><username>alice</username><password>practice123</password><role>staff</role></user>
    <user><username>bob</username><password>${seededSecret(ctx, "bob-password", 12)}</password><role>staff</role></user>
    <user><username>admin</username><password>${ADMIN_PASSWORD}</password><role>admin</role></user>
  </users>`,
);
const ARCHIVE = ["Q3-board-minutes.pdf", "vendor-contracts-2026.zip", "payroll-ledger-oct.xlsx"];

function shell(title: string, body: string, who?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#e5c07b",
    currentUserLabel: who ?? null,
    navLinks: who ? [{ href: "/archive", label: "Archive" }, { href: "/logout", label: "Log out" }] : [{ href: "/", label: "Sign in" }],
  });
}

function loginPage(error?: string): string {
  return shell(
    "Sign in",
    `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Sign in</h1>${error ? `<p style="color:#e07a7a;">${escapeHtml(error)}</p>` : ""}
      <form method="post" action="/login"><p><input type="text" name="username" placeholder="Username" /></p>
      <p><input type="password" name="password" placeholder="Password" /></p><button type="submit">Sign in</button></form>
      <p class="muted">Demo: <strong>alice</strong> / practice123</p></div>`,
  );
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    if (!s) return null;
    const hit = xpathElements(`//user[username='${s.user.replace(/'/g, "")}']`, doc)[0];
    return hit ? { username: childText(hit, "username"), role: childText(hit, "role") } : null;
  };

  app.get("/", async (req, reply) => {
    if (viewer(req)) return reply.redirect("/archive");
    reply.type("text/html");
    return loginPage();
  });

  // --- The vulnerable handler -------------------------------------------------
  app.post("/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    reply.type("text/html");
    if (typeof b.username !== "string" || typeof b.password !== "string" || b.username.length > 100 || b.password.length > 100) {
      reply.code(400);
      return loginPage("Enter a username and password.");
    }

    // VULNERABLE: input concatenated into the XPath expression.
    const expr = `//user[username='${b.username}' and password='${b.password}']`;
    let hits: ReturnType<typeof xpathElements>;
    try {
      hits = xpathElements(expr, doc);
    } catch (err) {
      reply.code(500);
      return loginPage(`Query error: ${(err as Error).message.split("\n")[0]}`);
    }
    const first = hits[0];
    if (!first) {
      reply.code(401);
      return loginPage("Incorrect username or password.");
    }

    const username = childText(first, "username");
    if (username === "admin" && b.password !== ADMIN_PASSWORD) {
      await reportSolve(ctx, `signed in as "admin" without its password via XPath ${expr}`);
    }
    sessions.set(reply, { user: username });
    return reply.redirect("/archive");
  });

  app.get("/archive", async (req, reply) => {
    const me = viewer(req);
    if (!me) return reply.redirect("/");
    reply.type("text/html");
    return shell(
      "Archive",
      `<div class="panel"><h1>Archive</h1><p>Signed in as <strong>${escapeHtml(me.username)}</strong> <span class="pill">${escapeHtml(me.role)}</span></p>
        ${me.role === "admin" ? `<h2>Restricted documents</h2><ul>${ARCHIVE.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : `<p class="muted">Restricted documents are for administrators.</p>`}</div>`,
      me.username,
    );
  });

  app.get("/logout", async (_req, reply) => {
    sessions.clear(reply);
    return reply.redirect("/");
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[archivebox] fatal error:", err);
  process.exit(1);
});
