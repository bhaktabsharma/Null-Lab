/**
 * BudgetBoard — Any Origin Welcome (CORS misconfiguration)
 *
 * /api/profile reflects the request's Origin header verbatim into
 * Access-Control-Allow-Origin and sets Access-Control-Allow-Credentials:
 * true — the combination that lets any other site read an authenticated
 * user's response via `fetch(..., { credentials: "include" })`, since a
 * wildcard '*' is not permitted together with credentials by browsers, so
 * reflecting the real Origin is what actually makes this exploitable.
 * /api/public-stats shows the safe contrast. Recorded server-side only when
 * BOTH headers are present together on an authenticated response to a
 * foreign Origin — the exact shape a browser needs to let the read through.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, makeSessions, registerPasswordLogin, renderShell } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "BudgetBoard";
const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const sessions = makeSessions<{ user: string }>(ctx, "bb_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#4caf7d", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/", label: "Home" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/", async (req, reply) => {
    const u = viewer(req);
    reply.type("text/html");
    return shell("Home", `<div class="panel"><h1>${u ? `Welcome back, ${u}` : "Welcome to BudgetBoard"}</h1><p class="muted">Track your household budget.</p></div>`, u ?? undefined);
  });

  // Safe contrast: no credentials, wildcard origin, nothing sensitive.
  app.get("/api/public-stats", async (_req, reply) => {
    reply.header("access-control-allow-origin", "*");
    return { medianMonthlySavingsUsd: 410 };
  });

  // --- The vulnerable handler -------------------------------------------------
  app.get("/api/profile", async (req, reply) => {
    const origin = req.headers.origin;
    const user = viewer(req);

    if (origin) {
      // VULNERABLE: the request's own Origin is reflected back, paired with credentials.
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    if (!user) return reply.code(401).send({ error: "login required" });

    const knownOrigins = new Set([`http://localhost:${ctx.port}`, `http://127.0.0.1:${ctx.port}`]);
    if (origin && !knownOrigins.has(origin)) {
      await reportSolve(ctx, `GET /api/profile returned Access-Control-Allow-Origin: ${origin} with Access-Control-Allow-Credentials: true for an authenticated request from a foreign origin`);
    }
    return { username: user, balanceUsd: 4820.5, savingsGoalUsd: 10000 };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[budgetboard] fatal error:", err);
  process.exit(1);
});
