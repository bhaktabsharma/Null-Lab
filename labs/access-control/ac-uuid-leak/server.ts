/**
 * NoteNest — Unguessable, But Not Secret (UUID-based identifier authorization)
 *
 * Notes are keyed by per-instance random-looking UUIDs, and GET /api/notes/:id
 * never checks ownership ("nobody can guess a UUID"). The public activity feed
 * discloses note ids. Recorded only when a note owned by someone ELSE is served.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  makeSessions,
  registerPasswordLogin,
  seededId,
  CLIENT_ESC_JS,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "NoteNest";

interface User {
  username: string;
  password: string;
  displayName: string;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "bob", password: "hunter22", displayName: "Bob Okafor" },
];
const noteAlice1 = { id: seededId(ctx, "note-alice-1"), owner: "alice", title: "Grocery list", body: "Oat milk, lemons, rice, the good coffee." };
const noteAlice2 = { id: seededId(ctx, "note-alice-2"), owner: "alice", title: "Draft toast", body: "Thanks everyone for coming — especially Marta, who drove four hours." };
const noteBob1 = { id: seededId(ctx, "note-bob-1"), owner: "bob", title: "Landlord call", body: "Deposit dispute: I have the move-in photos. Do NOT mention the sublet." };
const noteBob2 = { id: seededId(ctx, "note-bob-2"), owner: "bob", title: "Wifi", body: "Guest network password: harbor-lantern-42" };
const NOTES = [noteAlice1, noteAlice2, noteBob1, noteBob2];
// Public "community activity" feed — the leak.
const ACTIVITY = [
  { who: "alice", action: "created a note", noteId: noteAlice1.id, at: "2026-10-22T08:14:00Z" },
  { who: "bob", action: "edited a note", noteId: noteBob1.id, at: "2026-10-22T09:41:00Z" },
  { who: "alice", action: "edited a note", noteId: noteAlice2.id, at: "2026-10-22T10:02:00Z" },
  { who: "bob", action: "created a note", noteId: noteBob2.id, at: "2026-10-22T11:27:00Z" },
];

const sessions = makeSessions<{ user: string }>(ctx, "nn_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#ffd479",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/", label: "My notes" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const HOME_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const mine = await (await fetch("/api/notes")).json();
  document.getElementById("mine").innerHTML = mine.notes.map(function (n) {
    return "<li><strong>" + esc(n.title) + "</strong><br><span class='muted'>" + esc(n.body) + "</span></li>";
  }).join("");
  const feed = await (await fetch("/api/activity")).json();
  document.getElementById("feed").innerHTML = feed.events.map(function (e) {
    return "<li>" + esc(e.who) + " " + esc(e.action) + " <span class='muted'>" + esc(e.at) + "</span></li>";
  }).join("");
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
      "My notes",
      `<div class="grid">
        <div class="panel"><h1>My notes</h1><ul id="mine"></ul></div>
        <div class="panel"><h1>Community activity</h1><p class="muted">What people have been up to.</p><ul id="feed"></ul></div>
      </div>
      <script>${HOME_SCRIPT}</script>`,
      u.displayName,
    );
  });

  app.get("/api/notes", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { notes: NOTES.filter((n) => n.owner === u.username) };
  });

  // --- The vulnerable handler: "UUIDs are unguessable, so no ownership check". --
  app.get("/api/notes/:id", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const note = NOTES.find((n) => n.id === (req.params as { id: string }).id);
    if (!note) return reply.code(404).send({ error: "no such note" });
    if (note.owner !== u.username) {
      await reportSolve(ctx, `session user "${u.username}" read note ${note.id} owned by "${note.owner}" via GET /api/notes/:id`);
    }
    return { note };
  });

  // Public — and it includes the ids.
  app.get("/api/activity", async () => ({ events: ACTIVITY }));

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[notenest] fatal error:", err);
  process.exit(1);
});
