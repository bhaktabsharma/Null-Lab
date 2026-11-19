/**
 * Crewroster — Team Export (a CSV export includes a column nobody meant to ship)
 *
 * Exporting the team roster as CSV is a manager-only action, correctly gated.
 * The export query selects every column on the user record for convenience —
 * including the one-time password-reset token, a field the UI never displays
 * and that is meant to be emailed, used once, and invalidated. The field is
 * simply never excluded from the export. Recorded only when a password is
 * actually reset for another account using the token found in an export.
 */
import { randomBytes } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Crewroster";

type Role = "member" | "manager";
interface User {
  username: string;
  password: string;
  displayName: string;
  role: Role;
  email: string;
  resetToken: string | null;
  /** Set the moment this user's token appears in an export response — not at reset time. */
  resetTokenExposedViaExport: boolean;
}
const USERS: User[] = [
  // Alice already knows her own token the ordinary way (it was emailed to her) — it is never part
  // of any export, which is exactly what makes her own self-service reset legitimate.
  { username: "alice", password: "practice123", displayName: "Alice Chen", role: "manager", email: "alice@crewroster.example", resetToken: "self-service-7f3a1c9d", resetTokenExposedViaExport: false },
  { username: "ben", password: "Ben-Crew!61", displayName: "Ben Hollis", role: "member", email: "ben@crewroster.example", resetToken: randomBytes(9).toString("hex"), resetTokenExposedViaExport: false },
  { username: "carol", password: "Carol-Crew!62", displayName: "Carol Reyes", role: "member", email: "carol@crewroster.example", resetToken: null, resetTokenExposedViaExport: false },
];

const sessions = makeSessions<{ user: string }>(ctx, "crewroster_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#bd93f9",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/team", label: "Team" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/team", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/team" : "/login"));

  app.get("/team", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    const rows = USERS.map((x) => `<tr><td>${x.displayName}</td><td>${x.email}</td><td>${x.role}</td></tr>`).join("");
    return shell("Team", `<div class="panel"><h1>Team roster</h1><table><tr><th>Name</th><th>Email</th><th>Role</th></tr>${rows}</table>
      ${u.role === "manager" ? `<p><a href="/api/team/export">Export as CSV</a></p>` : ""}</div>`, u.displayName);
  });

  app.get("/api/team/export", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    if (u.role !== "manager") return reply.code(403).send({ error: "managers only" });
    const header = "username,email,role,password,resetToken";
    // every column on the record, selected for convenience — nothing excluded
    const rows = USERS.map((x) => [x.username, x.email, x.role, x.password, x.resetToken ?? ""].join(","));
    // The moment a token leaves through this over-broad export, it is no longer something only
    // the account holder's inbox has — mark it, independent of who later uses it or how.
    for (const u of USERS) if (u.resetToken) u.resetTokenExposedViaExport = true;
    reply.type("text/csv");
    return [header, ...rows].join("\n") + "\n";
  });

  app.post("/api/password-reset", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; token?: unknown; newPassword?: unknown };
    const target = typeof b.username === "string" ? USERS.find((x) => x.username === b.username) : undefined;
    if (!target) return reply.code(404).send({ error: "no such user" });
    if (!target.resetToken || target.resetToken !== b.token) return reply.code(400).send({ error: "invalid or expired reset token" });
    if (typeof b.newPassword !== "string" || b.newPassword.length < 6) return reply.code(400).send({ error: "newPassword must be at least 6 characters" });
    target.password = b.newPassword;
    target.resetToken = null;
    if (target.resetTokenExposedViaExport) {
      await reportSolve(ctx, `the password for "${target.username}" was reset using a one-time token that was never shown in the UI and had only ever been made available through the manager's CSV export`);
    }
    return { reset: true };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[crewroster] fatal error:", err);
  process.exit(1);
});
