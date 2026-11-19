/**
 * FitTrack — Whose Workouts Are These? (horizontal privilege escalation)
 *
 * Login issues a signed session (proving who signed in) AND a plain
 * `member` cookie holding a numeric id. The workouts page checks that a
 * valid session exists, but then looks the data up from the plain cookie.
 * Recorded only when the log of a DIFFERENT member is actually served.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  escapeHtml,
  makeSessions,
  readPlainCookie,
  scopedCookieName,
  registerPasswordLogin,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "FitTrack";

interface Member {
  id: number;
  username: string;
  password: string;
  displayName: string;
  note: string;
  workouts: { date: string; activity: string; detail: string }[];
}
const MEMBERS: Member[] = [
  {
    id: 1001, username: "alice", password: "practice123", displayName: "Alice Chen", note: "Training for the October 10k.",
    workouts: [
      { date: "2026-10-20", activity: "Easy run", detail: "5.2 km, 31:40" },
      { date: "2026-10-22", activity: "Intervals", detail: "6 × 400 m" },
    ],
  },
  {
    id: 1002, username: "bob", password: "hunter22", displayName: "Bob Okafor", note: "Rehab block — physio asked me not to share details.",
    workouts: [
      { date: "2026-10-21", activity: "Physio session", detail: "Knee mobility, 40 min" },
      { date: "2026-10-23", activity: "Swim", detail: "Pool, 1.2 km" },
    ],
  },
  {
    id: 1003, username: "carol", password: "Tr1athlon!", displayName: "Carol Mbeki", note: "Race-day weight: private.",
    workouts: [{ date: "2026-10-19", activity: "Long ride", detail: "92 km" }],
  },
];

const sessions = makeSessions<{ user: string }>(ctx, "ft_session");
const MEMBER_COOKIE = scopedCookieName(ctx, "member");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#7ddf8f",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/me/workouts", label: "My workouts" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  registerPasswordLogin(app, {
    users: MEMBERS,
    sessions,
    shell,
    appName: APP,
    home: "/me/workouts",
    demoLine: "Demo account: <strong>alice</strong> / practice123",
    onLogin: (reply, member) => {
      reply.setCookie(MEMBER_COOKIE, String(member.id), { path: "/", sameSite: "lax" });
    },
  });

  app.get("/", async (req, reply) => reply.redirect(sessions.read(req) ? "/me/workouts" : "/login"));

  // --- The vulnerable handler -------------------------------------------------
  app.get("/me/workouts", async (req, reply) => {
    const s = sessions.read(req);
    if (!s) return reply.redirect("/login");
    const signedIn = MEMBERS.find((m) => m.username === s.user)!;

    // VULNERABLE: whose data to show comes from a plain, client-controlled cookie.
    const raw = readPlainCookie(ctx, req, "member");
    const wanted = raw !== undefined ? MEMBERS.find((m) => String(m.id) === raw) : signedIn;
    if (!wanted) {
      reply.code(404);
      reply.type("text/html");
      return shell("Not found", `<div class="panel"><h1>No such member</h1></div>`, signedIn.displayName);
    }

    if (wanted.id !== signedIn.id) {
      await reportSolve(
        ctx,
        `session user "${signedIn.username}" was served the workout log of member ${wanted.id} ("${wanted.username}") because the member cookie said ${wanted.id}`,
      );
    }
    reply.type("text/html");
    return shell(
      "My workouts",
      `<div class="panel">
        <h1>Workouts — ${escapeHtml(wanted.displayName)} <span class="pill">#${wanted.id}</span></h1>
        <p class="muted">${escapeHtml(wanted.note)}</p>
        <table>
          <tr><th>Date</th><th>Activity</th><th>Detail</th></tr>
          ${wanted.workouts.map((w) => `<tr><td>${w.date}</td><td>${escapeHtml(w.activity)}</td><td>${escapeHtml(w.detail)}</td></tr>`).join("")}
        </table>
      </div>`,
      signedIn.displayName,
    );
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[fittrack] fatal error:", err);
  process.exit(1);
});
