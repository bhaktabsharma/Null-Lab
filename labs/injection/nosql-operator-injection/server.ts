/**
 * VaultCRM — Operators in the Password (NoSQL operator injection)
 *
 * The login endpoint hands the parsed JSON body straight to a MongoDB-style
 * document store: `users.findOne({ username, password })`. A field that is an
 * object like {"$ne": ""} is evaluated as a QUERY OPERATOR, not compared as a
 * value. Recorded only when the admin account is actually signed in with a
 * non-string username or password.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, makeSessions, seededSecret, DocCollection } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "VaultCRM";
const ADMIN_PASSWORD = seededSecret(ctx, "admin-password", 16);
const sessions = makeSessions<{ user: string }>(ctx, "vc_session");

const users = new DocCollection([
  { username: "alice", password: "practice123", role: "staff", displayName: "Alice Chen" },
  { username: "admin", password: ADMIN_PASSWORD, role: "admin", displayName: "Site Administrator" },
]);
const CUSTOMERS = [
  { name: "Northwind Foods", plan: "Enterprise", mrr: "7,000" },
  { name: "Contoso Logistics", plan: "Business", mrr: "10,540" },
];

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#7aa2ff",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/dashboard", label: "Dashboard" }, { href: "/logout", label: "Log out" }] : [{ href: "/", label: "Log in" }],
  });
}

const LOGIN_SCRIPT = `
document.getElementById("f").addEventListener("submit", async function (e) {
  e.preventDefault();
  const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: document.getElementById("u").value, password: document.getElementById("p").value }) });
  if (res.ok) { location.href = "/dashboard"; }
  else { document.getElementById("err").textContent = (await res.json()).error || "Sign-in failed."; }
});
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (users.findOne({ username: s.user }) ?? null) : null;
  };

  app.get("/", async (req, reply) => {
    if (viewer(req)) return reply.redirect("/dashboard");
    reply.type("text/html");
    return shell(
      "Log in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Sign in to ${APP}</h1>
        <form id="f"><p><input id="u" type="text" placeholder="Username" /></p><p><input id="p" type="password" placeholder="Password" /></p><button type="submit">Sign in</button></form>
        <p id="err" class="muted" style="color:#e07a7a;"></p><p class="muted">Staff demo: <strong>alice</strong> / practice123</p></div>
       <script>${LOGIN_SCRIPT}</script>`,
    );
  });

  // --- The vulnerable handler: the body goes straight into the query. ---------
  app.post("/api/login", async (req, reply) => {
    const body = req.body as { username?: unknown; password?: unknown } | null;
    let user;
    try {
      user = users.findOne({ username: body?.username, password: body?.password });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (!user) return reply.code(401).send({ error: "Invalid credentials." });

    if (user.role === "admin" && (typeof body?.username !== "string" || typeof body?.password !== "string")) {
      await reportSolve(ctx, `login as admin succeeded with a non-string credential: username=${JSON.stringify(body?.username)} password=${JSON.stringify(body?.password)}`);
    }
    sessions.set(reply, { user: String(user.username) });
    return { ok: true, role: user.role };
  });

  app.get("/dashboard", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/");
    reply.type("text/html");
    return shell(
      "Dashboard",
      `<div class="panel"><h1>Welcome, ${escapeHtml(String(u.displayName))}</h1><p>Role: <span class="pill">${escapeHtml(String(u.role))}</span></p>
        ${u.role === "admin" ? `<h2>Customer vault</h2><table><tr><th>Customer</th><th>Plan</th><th>MRR (USD)</th></tr>${CUSTOMERS.map((c) => `<tr><td>${c.name}</td><td>${c.plan}</td><td>${c.mrr}</td></tr>`).join("")}</table>` : `<p class="muted">The customer vault is for administrators.</p>`}</div>`,
      String(u.displayName),
    );
  });

  app.get("/logout", async (_req, reply) => {
    sessions.clear(reply);
    return reply.redirect("/");
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[vaultcrm] fatal error:", err);
  process.exit(1);
});
