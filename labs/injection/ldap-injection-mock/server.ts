/**
 * StaffDirectory — Filter Injection (LDAP injection, local MOCK directory)
 *
 * Login builds `(&(uid=<username>)(userPassword=<password>))` by string
 * concatenation and searches an in-memory directory with a real RFC 4515-style
 * filter evaluator. Metacharacters in either field change the filter's
 * structure. Recorded only when the 'admin' entry is signed in with a password
 * that is not its real one.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, makeSessions, seededSecret, ldapSearch, LdapFilterError, type LdapEntry } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "StaffDirectory";
const ADMIN_PASSWORD = seededSecret(ctx, "admin-password", 14);
const sessions = makeSessions<{ uid: string }>(ctx, "sd_session");

const DIRECTORY: LdapEntry[] = [
  { dn: "uid=alice,ou=people,dc=example,dc=test", attrs: { uid: ["alice"], cn: ["Alice Chen"], mail: ["alice@example.test"], userPassword: ["practice123"], title: ["Support Specialist"] } },
  { dn: "uid=bob,ou=people,dc=example,dc=test", attrs: { uid: ["bob"], cn: ["Bob Okafor"], mail: ["bob@example.test"], userPassword: [seededSecret(ctx, "bob-password", 12)], title: ["Network Engineer"] } },
  { dn: "uid=admin,ou=people,dc=example,dc=test", attrs: { uid: ["admin"], cn: ["Directory Admin"], mail: ["admin@example.test"], userPassword: [ADMIN_PASSWORD], title: ["Directory Administrator"] } },
];

function shell(title: string, body: string, who?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#8fd1ff",
    currentUserLabel: who ?? null,
    navLinks: who ? [{ href: "/directory", label: "Directory" }, { href: "/logout", label: "Log out" }] : [{ href: "/", label: "Sign in" }],
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
    return s ? (DIRECTORY.find((e) => e.attrs.uid?.[0] === s.uid) ?? null) : null;
  };

  app.get("/", async (req, reply) => {
    if (viewer(req)) return reply.redirect("/directory");
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

    // VULNERABLE: input concatenated into the search filter.
    const filter = `(&(uid=${b.username})(userPassword=${b.password}))`;
    let found: LdapEntry[];
    try {
      found = ldapSearch(DIRECTORY, filter);
    } catch (err) {
      reply.code(500);
      return loginPage(`Directory error: ${err instanceof LdapFilterError ? err.message : "search failed"}`);
    }
    const entry = found[0];
    if (!entry) {
      reply.code(401);
      return loginPage("Incorrect username or password.");
    }

    const uid = entry.attrs.uid?.[0] ?? "";
    if (uid === "admin" && b.password !== ADMIN_PASSWORD) {
      await reportSolve(ctx, `signed in as "admin" without its password via filter ${filter}`);
    }
    sessions.set(reply, { uid });
    return reply.redirect("/directory");
  });

  app.get("/directory", async (req, reply) => {
    const me = viewer(req);
    if (!me) return reply.redirect("/");
    const isAdmin = me.attrs.uid?.[0] === "admin";
    reply.type("text/html");
    return shell(
      "Directory",
      `<div class="panel"><h1>Company directory</h1><p class="muted">Signed in as ${escapeHtml(me.attrs.cn?.[0] ?? "")}.</p>
        <table><tr><th>Name</th><th>Title</th><th>Mail</th></tr>${DIRECTORY.map((e) => `<tr><td>${escapeHtml(e.attrs.cn?.[0] ?? "")}</td><td>${escapeHtml(e.attrs.title?.[0] ?? "")}</td><td>${escapeHtml(e.attrs.mail?.[0] ?? "")}</td></tr>`).join("")}</table>
        ${isAdmin ? `<h2>Administrator tools</h2><p class="muted">Directory export and password policy (synthetic).</p>` : ""}</div>`,
      me.attrs.cn?.[0],
    );
  });

  app.get("/logout", async (_req, reply) => {
    sessions.clear(reply);
    return reply.redirect("/");
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[staffdirectory] fatal error:", err);
  process.exit(1);
});
