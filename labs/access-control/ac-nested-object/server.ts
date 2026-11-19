/**
 * ProjectHub — Whose Task Is It Really? (nested-object authorization)
 *
 * GET /api/projects/:pid/tasks/:tid verifies the caller belongs to project
 * :pid, then looks the task up by id ALONE. Recorded only when the task that
 * is served belongs to a project the caller is not a member of.
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
const APP = "ProjectHub";

interface User {
  username: string;
  password: string;
  displayName: string;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "bob", password: "hunter22", displayName: "Bob Okafor" },
];
const PROJECTS = [
  { id: 1, name: "Website relaunch", members: ["alice"] },
  { id: 2, name: "Project Lighthouse (confidential)", members: ["bob"] },
];
const TASKS = [
  { id: 11, projectId: 1, title: "Draft new homepage copy", detail: "Due Friday; marketing to review." },
  { id: 12, projectId: 1, title: "Compress hero images", detail: "Target under 200 KB each." },
  { id: 21, projectId: 2, title: "Prepare data room", detail: "Legal wants the index by Monday." },
  { id: 22, projectId: 2, title: "Draft offer letter", detail: "Offer price: 4.2M. Board approval pending — do not circulate." },
];

const sessions = makeSessions<{ user: string }>(ctx, "ph_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#6fd6ff",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/", label: "Projects" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const HOME_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const res = await (await fetch("/api/projects")).json();
  const box = document.getElementById("projects");
  for (const p of res.projects) {
    const tasks = await (await fetch("/api/projects/" + p.id + "/tasks")).json();
    box.innerHTML += "<h2>" + esc(p.name) + "</h2><ul>" + tasks.tasks.map(function (t) {
      return "<li><a class='link' href='#' onclick=\\"show(" + p.id + "," + t.id + ");return false;\\">" + esc(t.title) + "</a></li>";
    }).join("") + "</ul>";
  }
}
async function show(pid, tid) {
  const r = await (await fetch("/api/projects/" + pid + "/tasks/" + tid)).json();
  document.getElementById("detail").textContent = r.task ? r.task.title + " — " + r.task.detail : JSON.stringify(r);
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };
  const isMember = (username: string, pid: number) => !!PROJECTS.find((p) => p.id === pid)?.members.includes(username);

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Projects",
      `<div class="panel"><h1>My projects</h1><div id="projects"></div><p class="panel" id="detail" style="background:#0b0e13;">Select a task.</p></div>
       <script>${HOME_SCRIPT}</script>`,
      u.displayName,
    );
  });

  app.get("/api/projects", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { projects: PROJECTS.filter((p) => p.members.includes(u.username)).map(({ id, name }) => ({ id, name })) };
  });

  app.get("/api/projects/:pid/tasks", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const pid = Number((req.params as { pid: string }).pid);
    if (!isMember(u.username, pid)) return reply.code(403).send({ error: "not a member of this project" });
    return { tasks: TASKS.filter((t) => t.projectId === pid).map(({ id, title }) => ({ id, title })) };
  });

  // --- The vulnerable handler ---------------------------------------------------
  app.get("/api/projects/:pid/tasks/:tid", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const { pid: rawPid, tid: rawTid } = req.params as { pid: string; tid: string };
    const pid = Number(rawPid);
    const tid = Number(rawTid);
    if (!isMember(u.username, pid)) return reply.code(403).send({ error: "not a member of this project" });

    // VULNERABLE: the task is found by id alone — its project is never compared with :pid.
    const task = TASKS.find((t) => t.id === tid);
    if (!task) return reply.code(404).send({ error: "no such task" });

    if (!isMember(u.username, task.projectId)) {
      await reportSolve(
        ctx,
        `session user "${u.username}" (member of project ${pid}) read task ${task.id} of project ${task.projectId} via GET /api/projects/${pid}/tasks/${task.id}`,
      );
    }
    return { task };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[projecthub] fatal error:", err);
  process.exit(1);
});
