/**
 * ProfileHub — Update My Profile (mass assignment / over-posting)
 *
 * PATCH /api/profile does `Object.assign(user, body)` — the entire parsed
 * request body is merged onto the stored record, not just the two fields
 * (displayName, bio) the UI exposes. Recorded only when a request actually
 * sets role to "admin" although it was never a field the form offered.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "ProfileHub";

interface User { username: string; password: string; displayName: string; bio: string; role: "user" | "admin"; }
const USERS: User[] = [{ username: "alice", password: "practice123", displayName: "Alice Chen", bio: "", role: "user" }];
const sessions = makeSessions<{ user: string }>(ctx, "ph3_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#4dc9c9", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/profile", label: "Profile" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/profile", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/profile", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Profile",
      `<div class="panel"><h1>Profile</h1><p>Display name: ${escapeHtml(u.displayName)}</p><p>Bio: ${escapeHtml(u.bio || "(empty)")}</p><p>Role: <span class="pill">${u.role}</span></p></div>`,
      u.displayName,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.patch("/api/profile", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const roleBefore = u.role;
    // VULNERABLE: the whole body is merged onto the record with no field allowlist.
    Object.assign(u, body);
    // Keep the username stable regardless of what was merged (otherwise the session lookup breaks).
    u.username = "alice";
    if (roleBefore !== "admin" && u.role === "admin") {
      await reportSolve(ctx, `PATCH /api/profile set role="admin" for "${u.username}" via a field the profile form never exposes`);
    }
    return { username: u.username, displayName: u.displayName, bio: u.bio, role: u.role };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[profilehub] fatal error:", err);
  process.exit(1);
});
