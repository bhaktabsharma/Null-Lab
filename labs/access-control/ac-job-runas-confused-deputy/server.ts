/**
 * Ledgerly — Report Builder (authorization bypass in an asynchronous job)
 *
 * Reports run as background jobs. The API checks the dataset permission in the
 * WORKER, using the identity stored on the job as `runAs` — and the enqueue
 * endpoint builds the job record from the request body, so a client can supply
 * `runAs` itself. Status and download are correctly restricted to the job's
 * creator. Recorded only when the creator downloads output that was produced
 * while the job ran as somebody else.
 */
import { randomBytes } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Ledgerly";

type Role = "analyst" | "finance";
interface User {
  username: string;
  password: string;
  displayName: string;
  role: Role;
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", role: "analyst" },
  { username: "bob", password: "Fin-Ledgerly!88", displayName: "Bob Marsh", role: "finance" },
];

const EXPENSES: Record<string, { date: string; category: string; amount: number }[]> = {
  alice: [
    { date: "2024-09-03", category: "Travel", amount: 212.4 },
    { date: "2024-09-17", category: "Software", amount: 49.0 },
  ],
  bob: [
    { date: "2024-09-05", category: "Consulting", amount: 4800.0 },
    { date: "2024-09-21", category: "Legal", amount: 1250.0 },
  ],
};
const PAYROLL = [
  { employee: "Alice Chen", monthly_gross: 5400 },
  { employee: "Bob Marsh", monthly_gross: 8900 },
  { employee: "Cleo Park", monthly_gross: 12100 },
];

type ReportName = "expenses" | "payroll";
const REPORTS: ReportName[] = ["expenses", "payroll"];

interface Job {
  id: string;
  report: ReportName;
  format: "csv" | "json";
  createdBy: string;
  runAs: string;
  status: "queued" | "running" | "done" | "failed";
  error?: string;
  output?: string;
}
const jobs: Job[] = [];

const sessions = makeSessions<{ user: string }>(ctx, "ledgerly_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#8be9fd",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/reports", label: "Reports" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function run(ev) {
  ev.preventDefault();
  const body = { report: document.getElementById("report").value, format: document.getElementById("format").value };
  const res = await fetch("/api/report-jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { document.getElementById("status").textContent = data.error; return; }
  poll(data.job.id);
}
async function poll(id) {
  const data = await (await fetch("/api/report-jobs/" + id)).json();
  const j = data.job;
  document.getElementById("status").innerHTML = "Job " + esc(j.id) + ": " + esc(j.status) + (j.error ? " — " + esc(j.error) : "") +
    (j.status === "done" ? ' — <a href="/api/report-jobs/' + esc(j.id) + '/download">download</a>' : "");
  if (j.status === "queued" || j.status === "running") setTimeout(function () { poll(id); }, 300);
}
document.getElementById("f").addEventListener("submit", run);
`;

/** Dataset permission, evaluated by the worker for whichever identity the job runs as. */
function runReport(identity: User, report: ReportName): { ok: true; rows: unknown[] } | { ok: false; error: string } {
  if (report === "payroll") {
    if (identity.role !== "finance") return { ok: false, error: `${identity.username} is not allowed to read payroll` };
    return { ok: true, rows: PAYROLL };
  }
  return { ok: true, rows: (EXPENSES[identity.username] ?? []).map((r) => ({ employee: identity.username, ...r })) };
}

function render(rows: unknown[], format: "csv" | "json"): string {
  if (format === "json") return JSON.stringify(rows, null, 2);
  const list = rows as Record<string, unknown>[];
  if (list.length === 0) return "";
  const cols = Object.keys(list[0]!);
  return [cols.join(","), ...list.map((r) => cols.map((c) => String(r[c])).join(","))].join("\n") + "\n";
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const viewer = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/reports", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(viewer(req) ? "/reports" : "/login"));

  app.get("/reports", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "Reports",
      `<div class="panel"><h1>Report builder</h1>
        <form id="f">
          <p><select id="report"><option value="expenses">My expenses</option><option value="payroll">Payroll summary (finance)</option></select>
             <select id="format"><option value="csv">CSV</option><option value="json">JSON</option></select>
             <button type="submit">Run report</button></p>
        </form><p id="status" class="muted"></p></div>
      <script>${PAGE_SCRIPT}</script>`,
      u.displayName,
    );
  });

  app.get("/api/me", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { username: u.username, role: u.role };
  });

  // --- Enqueue: any signed-in user; the job record is built from the request body. ---
  app.post("/api/report-jobs", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const body = (req.body ?? {}) as { report?: unknown; format?: unknown; runAs?: unknown };
    if (typeof body.report !== "string" || !REPORTS.includes(body.report as ReportName)) return reply.code(400).send({ error: "unknown report" });
    const format = body.format === "json" ? "json" : "csv";
    const job: Job = {
      id: `job-${randomBytes(4).toString("hex")}`,
      report: body.report as ReportName,
      format,
      createdBy: u.username,
      runAs: typeof body.runAs === "string" ? body.runAs : u.username, // trusted from the client
      status: "queued",
    };
    jobs.push(job);

    // The "worker": runs later, with the dataset check done for job.runAs.
    setTimeout(() => {
      job.status = "running";
    }, 80);
    setTimeout(() => {
      const identity = USERS.find((x) => x.username === job.runAs);
      if (!identity) {
        job.status = "failed";
        job.error = "unknown identity";
        return;
      }
      const result = runReport(identity, job.report);
      if (!result.ok) {
        job.status = "failed";
        job.error = result.error;
        return;
      }
      job.output = render(result.rows, job.format);
      job.status = "done";
    }, 350);

    return { job: { id: job.id, report: job.report, status: job.status, runAs: job.runAs } };
  });

  // Status and download are correctly restricted to the job's creator.
  app.get("/api/report-jobs/:id", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const job = jobs.find((j) => j.id === (req.params as { id: string }).id && j.createdBy === u.username);
    if (!job) return reply.code(404).send({ error: "no such job" });
    return { job: { id: job.id, report: job.report, status: job.status, runAs: job.runAs, error: job.error } };
  });

  app.get("/api/report-jobs/:id/download", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const job = jobs.find((j) => j.id === (req.params as { id: string }).id && j.createdBy === u.username);
    if (!job) return reply.code(404).send({ error: "no such job" });
    if (job.status !== "done" || job.output === undefined) return reply.code(409).send({ error: `job is ${job.status}` });
    if (job.runAs !== job.createdBy) {
      await reportSolve(ctx, `"${job.createdBy}" (role "${u.role}") downloaded the output of a "${job.report}" report job that ran as "${job.runAs}" — the worker authorized the dataset for the wrong identity`);
    }
    reply.type(job.format === "json" ? "application/json" : "text/csv");
    return job.output;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[ledgerly] fatal error:", err);
  process.exit(1);
});
