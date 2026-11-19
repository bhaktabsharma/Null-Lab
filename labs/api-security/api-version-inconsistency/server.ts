/**
 * AccountsAPI — v1 Never Went Away (API version inconsistency)
 *
 * /api/v2/accounts/:id correctly checks that the signed-in caller owns the
 * requested account — a fix shipped after a past incident. /api/v1/
 * accounts/:id, kept running for backwards compatibility, was never given
 * the same fix. Recorded only when v1 actually returns a DIFFERENT user's
 * account to the caller, while v2 (checked in the same request) correctly
 * refuses the identical request.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, makeSessions, registerPasswordLogin, renderShell } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "AccountsAPI";
interface User { username: string; password: string; displayName: string; }
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "bob", password: "hunter22", displayName: "Bob Okafor" },
];
const ACCOUNTS: Record<string, { id: number; balanceUsd: number }> = { alice: { id: 1, balanceUsd: 4820 }, bob: { id: 2, balanceUsd: 1190 } };
const sessions = makeSessions<{ user: string }>(ctx, "aa_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#6bb8e0", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
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
    return shell("AccountsAPI", `<div class="panel"><h1>AccountsAPI</h1><p class="muted">GET /api/v1/accounts/:id and /api/v2/accounts/:id. Your account id: ${u ? ACCOUNTS[u.username]!.id : "(log in)"}.</p></div>`, u?.displayName);
  });

  // Current version: correctly checks ownership.
  app.get("/api/v2/accounts/:id", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const id = Number((req.params as { id: string }).id);
    const mine = ACCOUNTS[u.username]!;
    if (mine.id !== id) return reply.code(403).send({ error: "not your account" });
    return mine;
  });

  // --- The vulnerable handler: the old version, with no ownership check. -------
  app.get("/api/v1/accounts/:id", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const id = Number((req.params as { id: string }).id);
    const entry = Object.entries(ACCOUNTS).find(([, acc]) => acc.id === id);
    if (!entry) return reply.code(404).send({ error: "no such account" });
    const [owner, account] = entry;
    if (owner !== u.username) {
      await reportSolve(ctx, `GET /api/v1/accounts/${id} returned "${owner}"'s account to signed-in user "${u.username}", while v2 correctly refuses the identical request`);
    }
    return account;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[accountsapi] fatal error:", err);
  process.exit(1);
});
