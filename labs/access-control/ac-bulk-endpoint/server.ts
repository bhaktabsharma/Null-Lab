/**
 * MailRoom — Export Selected (bulk endpoint authorization)
 *
 * GET /api/messages/:id correctly enforces ownership. The inbox's
 * "Export selected" feature uses POST /api/messages/batch, which fetches
 * every requested id without checking who owns it. Recorded only when the
 * response actually contains a message the caller doesn't own.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  makeSessions,
  registerPasswordLogin,
  CLIENT_ESC_JS,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "MailRoom";

interface User {
  username: string;
  password: string;
  displayName: string;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "bob", password: "hunter22", displayName: "Bob Okafor" },
];
const MESSAGES = [
  { id: 1, owner: "alice", subject: "Team offsite", body: "Booking the lakeside venue for the 14th." },
  { id: 2, owner: "alice", subject: "Invoice question", body: "Can you resend the September invoice?" },
  { id: 3, owner: "alice", subject: "Welcome!", body: "Glad to have you on the team." },
  { id: 4, owner: "bob", subject: "Re: contract terms", body: "I can go to 85k but not below. Keep this between us." },
  { id: 5, owner: "bob", subject: "Doctor's note", body: "Appointment confirmed for Tuesday, results in a week." },
  { id: 6, owner: "bob", subject: "Server credentials", body: "Staging login is deploy / S3curestaging#19 — rotate after Friday." },
];

const sessions = makeSessions<{ user: string }>(ctx, "mr_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#ff7eb6",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/", label: "Inbox" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const INBOX_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const r = await (await fetch("/api/messages")).json();
  document.getElementById("rows").innerHTML = r.messages.map(function (m) {
    return "<tr><td><input type='checkbox' class='sel' value='" + m.id + "'></td><td>#" + m.id + "</td><td>" + esc(m.subject) + "</td></tr>";
  }).join("");
}
async function exportSelected() {
  const ids = Array.prototype.map.call(document.querySelectorAll(".sel:checked"), function (c) { return Number(c.value); });
  const res = await fetch("/api/messages/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ids }) });
  document.getElementById("out").textContent = JSON.stringify(await res.json(), null, 2);
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Inbox",
      `<div class="panel"><h1>Inbox</h1>
        <table><tr><th></th><th>ID</th><th>Subject</th></tr><tbody id="rows"></tbody></table>
        <p><button onclick="exportSelected()">Export selected</button></p>
        <pre id="out" class="muted"></pre></div>
       <script>${INBOX_SCRIPT}</script>`,
      u.displayName,
    );
  });

  app.get("/api/messages", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { messages: MESSAGES.filter((m) => m.owner === u.username).map(({ id, subject }) => ({ id, subject })) };
  });

  // Correctly protected.
  app.get("/api/messages/:id", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const m = MESSAGES.find((x) => x.id === Number((req.params as { id: string }).id));
    if (!m) return reply.code(404).send({ error: "no such message" });
    if (m.owner !== u.username) return reply.code(403).send({ error: "not your message" });
    return { message: m };
  });

  // --- The vulnerable handler: the bulk path has no per-item check. ------------
  app.post("/api/messages/batch", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const ids = (req.body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || !ids.every((i) => Number.isInteger(i))) {
      return reply.code(400).send({ error: "ids must be a list of 1-20 integers" });
    }
    const found = MESSAGES.filter((m) => ids.includes(m.id));
    const foreign = found.filter((m) => m.owner !== u.username);
    if (foreign.length > 0) {
      await reportSolve(
        ctx,
        `session user "${u.username}" received ${foreign.length} message(s) owned by others (ids ${foreign.map((m) => m.id).join(",")}) via POST /api/messages/batch`,
      );
    }
    return { messages: found };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[mailroom] fatal error:", err);
  process.exit(1);
});
