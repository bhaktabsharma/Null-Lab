/**
 * ClubHouse — Registered Trouble (second-order SQL injection)
 *
 * Registration, login and post creation all use bound parameters and are
 * safe. But /my-posts later builds a query by concatenating the STORED
 * username. A payload registered as a username is stored harmlessly, then
 * executes when its owner views their posts. Recorded only when the secret
 * from the hidden table actually appears in the page sent to the member.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, openInstanceDb, renderShell, escapeHtml, makeSessions, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const db = openInstanceDb(ctx);
const APP = "ClubHouse";
const VAULT_NOTE = `VAULT-${seededSecret(ctx, "vault-note", 10)}`;
const sessions = makeSessions<{ user: string }>(ctx, "ch_session");

db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT);
  CREATE TABLE posts (id INTEGER PRIMARY KEY, author TEXT, title TEXT, body TEXT);
  CREATE TABLE vault (id INTEGER PRIMARY KEY, note TEXT);
`);
db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run("alice", seededSecret(ctx, "alice-pw", 12));
const addPost = db.prepare("INSERT INTO posts (author, title, body) VALUES (?, ?, ?)");
addPost.run("alice", "Welcome to the club", "Glad to have everyone here. Be kind.");
addPost.run("alice", "Quiz night", "Thursdays at 7 in the back room.");
db.prepare("INSERT INTO vault (note) VALUES (?)").run(VAULT_NOTE);

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#ff6fae",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/my-posts", label: "My posts" }, { href: "/logout", label: "Log out" }] : [{ href: "/register", label: "Register" }, { href: "/login", label: "Log in" }],
  });
}

const authForm = (action: string, title: string, note = "") =>
  `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>${title}</h1>${note}
    <form method="post" action="${action}"><p><input type="text" name="username" placeholder="Username" /></p>
    <p><input type="password" name="password" placeholder="Password" /></p><button type="submit">${title}</button></form></div>`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;

  app.get("/", async (req, reply) => reply.redirect(viewer(req) ? "/my-posts" : "/login"));

  app.get("/register", async (_req, reply) => {
    reply.type("text/html");
    return shell("Register", authForm("/register", "Register"));
  });
  app.post("/register", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    reply.type("text/html");
    if (typeof b.username !== "string" || typeof b.password !== "string" || !b.username || !b.password || b.username.length > 120 || b.password.length > 100) {
      reply.code(400);
      return shell("Register", authForm("/register", "Register", `<p class="muted" style="color:#e07a7a;">Username (max 120 chars) and password are required.</p>`));
    }
    try {
      db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(b.username, b.password); // safe: bound parameters
    } catch {
      reply.code(409);
      return shell("Register", authForm("/register", "Register", `<p class="muted" style="color:#e07a7a;">That username is taken.</p>`));
    }
    return reply.redirect("/login");
  });

  app.get("/login", async (_req, reply) => {
    reply.type("text/html");
    return shell("Log in", authForm("/login", "Log in"));
  });
  app.post("/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const row =
      typeof b.username === "string" && typeof b.password === "string"
        ? (db.prepare("SELECT username FROM users WHERE username = ? AND password = ?").get(b.username, b.password) as { username: string } | undefined) // safe
        : undefined;
    if (!row) return reply.redirect("/login");
    sessions.set(reply, { user: row.username });
    return reply.redirect("/my-posts");
  });
  app.get("/logout", async (_req, reply) => {
    sessions.clear(reply);
    return reply.redirect("/login");
  });

  app.post("/posts", async (req, reply) => {
    const user = viewer(req);
    if (!user) return reply.redirect("/login");
    const b = (req.body ?? {}) as { title?: unknown; body?: unknown };
    if (typeof b.title === "string" && typeof b.body === "string" && b.title && b.title.length <= 100 && b.body.length <= 500) {
      addPost.run(user, b.title, b.body); // safe: bound parameters
    }
    return reply.redirect("/my-posts");
  });

  // --- The vulnerable handler: the stored username is concatenated. -----------
  app.get("/my-posts", async (req, reply) => {
    const user = viewer(req);
    if (!user) return reply.redirect("/login");

    let rows: { title: string; body: string }[] = [];
    let failed = false;
    try {
      rows = db.prepare(`SELECT title, body FROM posts WHERE author = '${user}'`).all() as typeof rows;
    } catch {
      failed = true;
    }

    const html = shell(
      "My posts",
      `<div class="panel"><h1>My posts</h1>
        ${failed ? `<p>Could not load your posts.</p>` : rows.length ? `<table><tr><th>Title</th><th>Body</th></tr>${rows.map((r) => `<tr><td>${escapeHtml(String(r.title))}</td><td>${escapeHtml(String(r.body))}</td></tr>`).join("")}</table>` : `<p class="muted">You haven't posted anything yet.</p>`}
        <form method="post" action="/posts" style="margin-top:1rem;"><p><input type="text" name="title" placeholder="Title" /></p><p><input type="text" name="body" placeholder="Say something" /></p><button type="submit">Post</button></form></div>`,
      user,
    );
    if (html.includes(VAULT_NOTE)) {
      await reportSolve(ctx, `GET /my-posts returned the hidden vault note to member "${user}" — a stored username was executed as SQL`);
    }
    reply.type("text/html");
    return html;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[clubhouse] fatal error:", err);
  process.exit(1);
});
