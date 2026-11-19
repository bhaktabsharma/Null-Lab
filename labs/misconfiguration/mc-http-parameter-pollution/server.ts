/**
 * SearchAPI — Which One Wins? (HTTP parameter pollution)
 *
 * When a query parameter is repeated, Fastify's query-string parser (like
 * many) returns an ARRAY of all its values. Two parts of this handler
 * disagree about which element of that array matters: the OWNERSHIP CHECK
 * takes the FIRST value (`Array.isArray(v) ? v[0] : v`), while the DATA
 * LOOKUP — written as a separate step, as if by a different part of the
 * codebase — takes the LAST (`Array.isArray(v) ? v[v.length - 1] : v`). A
 * request repeating the parameter can pass the check with one value while
 * the lookup actually uses another. Recorded only when the returned record
 * genuinely belongs to someone other than the caller, on a request whose
 * ownership check passed.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, makeSessions, registerPasswordLogin, renderShell } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "SearchAPI";
interface User { username: string; password: string; displayName: string; }
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "bob", password: "hunter22", displayName: "Bob Okafor" },
];
const ACCOUNTS: Record<string, { balanceUsd: number; note: string }> = {
  alice: { balanceUsd: 4820, note: "Personal checking." },
  bob: { balanceUsd: 1190, note: "Joint account — see shared statement for details, do not disclose balance publicly." },
};
const sessions = makeSessions<{ user: string }>(ctx, "sa_session");

function firstValue(v: unknown): string {
  return Array.isArray(v) ? String(v[0]) : String(v ?? "");
}
function lastValue(v: unknown): string {
  return Array.isArray(v) ? String(v[v.length - 1]) : String(v ?? "");
}

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#e08a5c", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/", async (req, reply) => {
    const u = viewer(req);
    reply.type("text/html");
    return shell("SearchAPI", `<div class="panel"><h1>SearchAPI</h1><p class="muted">GET /api/account?userId=${u?.username ?? "<username>"}</p></div>`, u?.displayName);
  });

  // --- The vulnerable handler --------------------------------------------------
  app.get("/api/account", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });

    const raw = (req.query as { userId?: unknown }).userId;
    // Step 1: ownership check — reads the FIRST value.
    const checkedId = firstValue(raw);
    if (checkedId !== u.username) {
      return reply.code(403).send({ error: "not your account" });
    }
    // Step 2: the actual lookup — reads the LAST value. VULNERABLE: disagrees with step 1.
    const lookupId = lastValue(raw);
    const account = ACCOUNTS[lookupId];
    if (!account) return reply.code(404).send({ error: "no such account" });

    if (lookupId !== u.username) {
      await reportSolve(ctx, `GET /api/account passed its ownership check for "${checkedId}" but returned the account for "${lookupId}" instead`);
    }
    return { username: lookupId, ...account };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[searchapi-hpp] fatal error:", err);
  process.exit(1);
});
