/**
 * PrefSync — Import Your Settings (insecure deserialization / object injection)
 *
 * Settings are exported as JSON with a `__type` field, and import picks a
 * constructor from an internal REGISTRY keyed by that field — a simplified,
 * JS-safe stand-in for the class of bug behind Java/PHP/Python "insecure
 * deserialization" (where a serialized blob's own type information controls
 * what gets instantiated). There is no eval/Function/real deserialization
 * library involved: the registry is a plain object of known constructors,
 * but it also contains an INTERNAL type ("AdminGrant") that the public
 * import endpoint should never construct directly — only the UI's own two
 * preference types should be reachable. Recorded only when import actually
 * constructs something other than those two types and that construction
 * sets the signed-in account's admin flag.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "PrefSync";

interface User { username: string; password: string; displayName: string; admin: boolean; }
const USERS: User[] = [{ username: "alice", password: "practice123", displayName: "Alice Chen", admin: false }];
const sessions = makeSessions<{ user: string }>(ctx, "ps_session");

type Constructed = { kind: string; describe: string };
type Ctor = (data: Record<string, unknown>, user: User) => Constructed;

// VULNERABLE: this registry is reachable by name from untrusted input, and
// contains an internal type alongside the two the UI is meant to offer.
const REGISTRY: Record<string, Ctor> = {
  ThemePreference: (data) => ({ kind: "ThemePreference", describe: `theme=${String(data.theme ?? "light")}` }),
  NotificationPreference: (data) => ({ kind: "NotificationPreference", describe: `emailDigest=${String(data.emailDigest ?? "weekly")}` }),
  // Internal-only type: used by an admin-provisioning script, never meant to be reachable from /settings/import.
  AdminGrant: (_data, user) => {
    user.admin = true;
    return { kind: "AdminGrant", describe: "admin flag set" };
  },
};

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#c77dff", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/settings", label: "Settings" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/settings", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/settings", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Settings",
      `<div class="panel"><h1>Settings</h1><p>Admin: <span class="pill">${u.admin ? "yes" : "no"}</span></p>
        <p><a class="link" href="/settings/export?type=ThemePreference">Export theme preference</a></p>
        <form method="post" action="/settings/import"><p><textarea name="payload" rows="4" style="width:100%;">{"__type":"ThemePreference","theme":"dark"}</textarea></p><button type="submit">Import</button></form></div>`,
      u.displayName,
    );
  });

  app.get("/settings/export", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    const type = String((req.query as { type?: string }).type ?? "ThemePreference");
    return { __type: type === "NotificationPreference" ? "NotificationPreference" : "ThemePreference", theme: "dark", emailDigest: "weekly" };
  });

  // --- The vulnerable handler --------------------------------------------------
  app.post("/settings/import", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    const raw = (req.body as { payload?: unknown } | null)?.payload;
    reply.type("text/html");
    let data: Record<string, unknown>;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : {};
    } catch {
      reply.code(400);
      return shell("Import failed", `<div class="panel"><p>Invalid payload.</p></div>`, u.displayName);
    }
    const type = typeof data.__type === "string" ? data.__type : "";
    const ctor = REGISTRY[type];
    if (!ctor) {
      reply.code(400);
      return shell("Import failed", `<div class="panel"><p>Unknown type "${escapeHtml(type)}".</p></div>`, u.displayName);
    }

    const before = u.admin;
    const result = ctor(data, u);
    if (type !== "ThemePreference" && type !== "NotificationPreference" && u.admin && !before) {
      await reportSolve(ctx, `POST /settings/import constructed type "${type}" (not a public preference type) and it set admin=true for "${u.username}"`);
    }
    return shell("Imported", `<div class="panel"><p>Imported ${escapeHtml(result.kind)}: ${escapeHtml(result.describe)}</p><p><a class="link" href="/settings">Back</a></p></div>`, u.displayName);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[prefsync] fatal error:", err);
  process.exit(1);
});
