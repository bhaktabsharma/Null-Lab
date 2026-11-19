/**
 * Teamboard — The Button You Can't See (broken function-level authorization)
 *
 * The UI only renders Remove buttons for admins, but the JavaScript that
 * would call the endpoint is shipped to everyone and the endpoint itself only
 * checks that the caller is logged in. Recorded only when a removal actually
 * succeeds for a non-admin session.
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
const APP = "Teamboard";

interface User {
  username: string;
  password: string;
  displayName: string;
  role: "member" | "admin";
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", role: "member" },
  { username: "tess", password: "Adm1n-Team!42", displayName: "Tess Duarte", role: "admin" },
];
let members = [
  { id: 1, name: "Alice Chen", title: "Designer" },
  { id: 2, name: "Tess Duarte", title: "Team lead" },
  { id: 3, name: "Ben Hollis", title: "Engineer" },
  { id: 4, name: "Dana Whitfield", title: "Engineer" },
  { id: 5, name: "Eli Sato", title: "Analyst" },
];

const sessions = makeSessions<{ user: string }>(ctx, "tb_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#c792ea",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/team", label: "Team" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const TEAM_PAGE_SCRIPT = `
${CLIENT_ESC_JS}
const API = {
  me: "/api/me",
  list: "/api/members",
  // admin tooling — wired up only when the signed-in user is an admin
  remove: function (id) { return "/api/members/" + id + "/remove"; }
};
async function load() {
  const me = await (await fetch(API.me)).json();
  const list = await (await fetch(API.list)).json();
  document.getElementById("rows").innerHTML = list.members.map(function (m) {
    const btn = me.role === "admin"
      ? '<button onclick="removeMember(' + m.id + ')">Remove</button>' : "";
    return "<tr><td>" + esc(m.name) + "</td><td>" + esc(m.title) + "</td><td>" + btn + "</td></tr>";
  }).join("");
}
async function removeMember(id) {
  await fetch(API.remove(id), { method: "POST" });
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/team", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/", async (req, reply) => reply.redirect(viewer(req) ? "/team" : "/login"));

  app.get("/team", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Team",
      `<div class="panel">
        <h1>Team</h1>
        <table><tr><th>Name</th><th>Title</th><th></th></tr><tbody id="rows"></tbody></table>
      </div>
      <script>${TEAM_PAGE_SCRIPT}</script>`,
      u.displayName,
    );
  });

  app.get("/api/me", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { username: u.username, role: u.role };
  });

  app.get("/api/members", async (req, reply) => {
    if (!viewer(req)) return reply.code(401).send({ error: "login required" });
    return { members };
  });

  // --- The vulnerable handler: authenticated, but never authorized. ------------
  app.post("/api/members/:id/remove", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const id = Number((req.params as { id: string }).id);
    const target = members.find((m) => m.id === id);
    if (!target) return reply.code(404).send({ error: "no such member" });

    members = members.filter((m) => m.id !== id);
    if (u.role !== "admin") {
      await reportSolve(ctx, `session user "${u.username}" (role "${u.role}") removed member ${id} ("${target.name}") via POST /api/members/${id}/remove`);
    }
    return { removed: target };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[teamboard] fatal error:", err);
  process.exit(1);
});
