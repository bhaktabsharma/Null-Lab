/**
 * ProfileHub — Edit Profile (protection applied in one Content-Type branch, not the other)
 *
 * Profile updates sent as JSON go through a strict parser that allow-lists
 * exactly two fields (displayName, bio) — role can never be set that way. A
 * second code path was added "to support old clients that send text/plain
 * instead of JSON" and JSON.parses the raw body itself, applying every field
 * on it directly with no allow-list at all. Recorded only when a profile's
 * role is changed to admin through a request whose Content-Type is not
 * application/json.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "ProfileHub";

interface User {
  username: string;
  password: string;
  displayName: string;
  bio: string;
  role: "user" | "admin";
}
const USERS: User[] = [{ username: "alice", password: "practice123", displayName: "Alice Chen", bio: "Product designer.", role: "user" }];

const sessions = makeSessions<{ user: string }>(ctx, "profilehub_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#f1fa8c",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/profile", label: "My profile" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  // "Support for legacy clients": text/plain bodies are read as a raw string, parsed by the handler itself.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => done(null, body));
  const who = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/profile", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/profile" : "/login"));

  app.get("/profile", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell("My profile", `<div class="panel"><h1>My profile</h1><p>Name: ${u.displayName}</p><p>Bio: ${u.bio}</p><p>Role: ${u.role}</p>
      <form id="f"><p><input id="n" value="${u.displayName}" /></p><p><input id="b" value="${u.bio}" /></p><button type="submit">Save</button></form></div>
      <script>document.getElementById("f").addEventListener("submit", async function (e) { e.preventDefault();
        await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: document.getElementById("n").value, bio: document.getElementById("b").value }) });
        location.reload(); });</script>`, u.displayName);
  });

  // The strict path: a JSON body is picked apart field by field — only these two are ever applied.
  app.patch("/api/profile", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim();

    if (contentType === "application/json") {
      const body = (req.body ?? {}) as { displayName?: unknown; bio?: unknown };
      if (body.displayName !== undefined) {
        if (typeof body.displayName !== "string" || body.displayName.length === 0 || body.displayName.length > 60) return reply.code(400).send({ error: "displayName must be 1-60 characters" });
        u.displayName = body.displayName;
      }
      if (body.bio !== undefined) {
        if (typeof body.bio !== "string" || body.bio.length > 300) return reply.code(400).send({ error: "bio must be up to 300 characters" });
        u.bio = body.bio;
      }
      return { profile: { displayName: u.displayName, bio: u.bio, role: u.role } };
    }

    // The legacy fallback: parses the raw text as JSON itself and applies the WHOLE object — no allow-list.
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(String(req.body ?? "{}"));
    } catch {
      return reply.code(400).send({ error: "body is not valid JSON" });
    }
    if (typeof patch !== "object" || patch === null) return reply.code(400).send({ error: "body must be a JSON object" });
    Object.assign(u, patch);
    if (u.role === "admin") {
      await reportSolve(ctx, `"${u.username}"'s role was set to "admin" through PATCH /api/profile sent with Content-Type ${contentType || "(none)"} — the JSON branch's field allow-list does not run on that path`);
    }
    return { profile: { displayName: u.displayName, bio: u.bio, role: u.role } };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[profilehub] fatal error:", err);
  process.exit(1);
});
