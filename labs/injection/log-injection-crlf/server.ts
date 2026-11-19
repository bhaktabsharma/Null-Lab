/**
 * SecureGate — Forged Entries (log injection / CRLF)
 *
 * Every login attempt appends a line to a line-oriented security log. The
 * username is written in raw, so a value containing a newline injects extra
 * lines. The public status page parses each line as a separate event and
 * counts administrator sign-ins. Recorded only when the log really contains a
 * well-formed admin sign-in event although the admin never signed in.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, makeSessions, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "SecureGate";
const ADMIN_PASSWORD = seededSecret(ctx, "admin-password", 16);
const USERS = [
  { username: "alice", password: "practice123" },
  { username: "admin", password: ADMIN_PASSWORD },
];
const sessions = makeSessions<{ user: string }>(ctx, "sg_session");

const ts = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
let logBuffer =
  `${ts(-3_600_000)} INFO service started\n` +
  `${ts(-1_800_000)} INFO login success for user "alice" from 10.0.0.12\n` +
  `${ts(-900_000)} WARN failed login for user "mallory" from 203.0.113.9\n`;
let adminReallySignedIn = false;
let solved = false;

const EVENT = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (INFO|WARN) (.*)$/;
const ADMIN_SUCCESS = /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO login success for user "admin" from \S+/;

async function writeLog(level: "INFO" | "WARN", message: string): Promise<void> {
  // VULNERABLE: the message is appended without neutralising CR/LF.
  logBuffer += `${ts()} ${level} ${message}\n`;
  if (!solved && !adminReallySignedIn && logBuffer.split("\n").some((l) => ADMIN_SUCCESS.test(l))) {
    solved = true;
    await reportSolve(ctx, "the security log now contains an admin sign-in entry although the admin never signed in (forged via an injected line)");
  }
}

function shell(title: string, body: string, who?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#ffd166",
    currentUserLabel: who ?? null,
    navLinks: [{ href: "/", label: "Sign in" }, { href: "/status", label: "Security status" }],
  });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (req, reply) => {
    const me = sessions.read(req)?.user;
    reply.type("text/html");
    return shell(
      "Sign in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>${me ? `Signed in as ${escapeHtml(me)}` : "Sign in"}</h1>
        <form method="post" action="/login"><p><input type="text" name="username" placeholder="Username" /></p>
        <p><input type="password" name="password" placeholder="Password" /></p><button type="submit">Sign in</button></form>
        <p class="muted">Demo: <strong>alice</strong> / practice123</p></div>`,
      me,
    );
  });

  app.post("/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof b.username === "string" ? b.username.slice(0, 300) : "";
    const password = typeof b.password === "string" ? b.password : "";
    const user = USERS.find((u) => u.username === username && u.password === password);
    if (!user) {
      await writeLog("WARN", `failed login for user "${username}" from ${req.ip}`);
      return reply.redirect("/?error=1");
    }
    if (user.username === "admin") adminReallySignedIn = true;
    await writeLog("INFO", `login success for user "${user.username}" from ${req.ip}`);
    sessions.set(reply, { user: user.username });
    return reply.redirect("/");
  });

  app.get("/status", async (_req, reply) => {
    const lines = logBuffer.split("\n").filter((l) => l.length > 0).slice(-30);
    const adminSignIns = lines.filter((l) => ADMIN_SUCCESS.test(l)).length;
    reply.type("text/html");
    return shell(
      "Security status",
      `<div class="panel"><h1>Recent security events</h1>
        <p>Administrator sign-ins in this window: <strong>${adminSignIns}</strong></p>
        <table><tr><th>Time</th><th>Level</th><th>Event</th></tr>${lines
          .map((l) => {
            const m = EVENT.exec(l);
            return m ? `<tr><td>${escapeHtml(m[1]!)}</td><td>${m[2]}</td><td>${escapeHtml(m[3]!)}</td></tr>` : `<tr><td colspan="3" class="muted">${escapeHtml(l)}</td></tr>`;
          })
          .join("")}</table></div>`,
    );
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[securegate] fatal error:", err);
  process.exit(1);
});
