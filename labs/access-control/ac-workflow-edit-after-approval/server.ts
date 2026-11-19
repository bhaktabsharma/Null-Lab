/**
 * ExpenseDesk — Approved Is Not Final (workflow-step integrity)
 *
 * submitted → approved (manager) → paid (owner). The approve step is enforced
 * and pay requires "approved" — but PATCH still lets the owner change an
 * approved expense, so what is paid no longer matches what was approved.
 * Recorded only when a payout succeeds with amount !== approvedAmount.
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
const APP = "ExpenseDesk";

interface User {
  username: string;
  password: string;
  displayName: string;
  role: "employee" | "manager";
}
const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen", role: "employee" },
  { username: "bob", password: "Mgr-Approve!55", displayName: "Bob Okafor", role: "manager" },
];

type Status = "submitted" | "approved" | "paid";
interface Expense {
  id: number;
  owner: string;
  description: string;
  amount: number;
  status: Status;
  approvedAmount: number | null;
}
const EXPENSES: Expense[] = [
  { id: 100, owner: "alice", description: "Conference travel", amount: 480, status: "submitted", approvedAmount: null },
  { id: 101, owner: "alice", description: "Team lunch", amount: 62.4, status: "approved", approvedAmount: 62.4 },
  { id: 200, owner: "bob", description: "Laptop dock", amount: 129, status: "submitted", approvedAmount: null },
];
let nextId = 300;

const sessions = makeSessions<{ user: string }>(ctx, "ed_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#ffb86b",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/", label: "My expenses" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const HOME_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const r = await (await fetch("/api/expenses")).json();
  document.getElementById("rows").innerHTML = r.expenses.map(function (e) {
    const action = e.status === "approved" ? "<button onclick='pay(" + e.id + ")'>Request payout</button>" : "";
    return "<tr><td>E-" + e.id + "</td><td>" + esc(e.description) + "</td><td>" + e.amount.toFixed(2) + "</td><td><span class='pill'>" + esc(e.status) + "</span></td><td>" + action + "</td></tr>";
  }).join("");
}
async function pay(id) {
  const res = await fetch("/api/expenses/" + id + "/pay", { method: "POST" });
  document.getElementById("msg").textContent = JSON.stringify(await res.json());
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

  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "My expenses",
      `<div class="panel"><h1>My expenses</h1>
        <table><tr><th>Ref</th><th>Description</th><th>Amount</th><th>Status</th><th></th></tr><tbody id="rows"></tbody></table>
        <p class="muted" id="msg"></p></div><script>${HOME_SCRIPT}</script>`,
      u.displayName,
    );
  });

  app.get("/api/expenses", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { expenses: EXPENSES.filter((e) => e.owner === u.username) };
  });

  app.post("/api/expenses", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const b = (req.body ?? {}) as { description?: unknown; amount?: unknown };
    if (typeof b.description !== "string" || b.description.length === 0 || b.description.length > 100) return reply.code(400).send({ error: "description required (max 100 chars)" });
    if (typeof b.amount !== "number" || !(b.amount > 0) || b.amount > 10000) return reply.code(400).send({ error: "amount must be between 0 and 10000" });
    const e: Expense = { id: nextId++, owner: u.username, description: b.description, amount: b.amount, status: "submitted", approvedAmount: null };
    EXPENSES.push(e);
    return reply.code(201).send({ expense: e });
  });

  // Correctly enforced: managers only, and never your own claim.
  app.post("/api/expenses/:id/approve", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const e = EXPENSES.find((x) => x.id === Number((req.params as { id: string }).id));
    if (!e) return reply.code(404).send({ error: "no such expense" });
    if (u.role !== "manager") return reply.code(403).send({ error: "managers only" });
    if (e.owner === u.username) return reply.code(403).send({ error: "you cannot approve your own expense" });
    if (e.status !== "submitted") return reply.code(409).send({ error: `expense is ${e.status}` });
    e.status = "approved";
    e.approvedAmount = e.amount;
    return { expense: e };
  });

  // --- The flaw: editable even after approval. ---------------------------------
  app.patch("/api/expenses/:id", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const e = EXPENSES.find((x) => x.id === Number((req.params as { id: string }).id));
    if (!e) return reply.code(404).send({ error: "no such expense" });
    if (e.owner !== u.username) return reply.code(403).send({ error: "not your expense" });
    // Should be: only while "submitted". Paid expenses are locked, approved ones are not.
    if (e.status === "paid") return reply.code(409).send({ error: "paid expenses are locked" });
    const b = (req.body ?? {}) as { description?: unknown; amount?: unknown };
    if (typeof b.description === "string" && b.description.length > 0 && b.description.length <= 100) e.description = b.description;
    if (typeof b.amount === "number" && b.amount > 0 && b.amount <= 100000) e.amount = b.amount;
    return { expense: e };
  });

  app.post("/api/expenses/:id/pay", async (req, reply) => {
    const u = viewer(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const e = EXPENSES.find((x) => x.id === Number((req.params as { id: string }).id));
    if (!e) return reply.code(404).send({ error: "no such expense" });
    if (e.owner !== u.username) return reply.code(403).send({ error: "not your expense" });
    if (e.status === "paid") return reply.code(409).send({ error: "already paid" });
    if (e.status !== "approved") return reply.code(409).send({ error: "expense is not approved yet" });

    if (e.approvedAmount !== null && e.amount !== e.approvedAmount) {
      await reportSolve(ctx, `expense E-${e.id} was paid ${e.amount.toFixed(2)} although the manager approved ${e.approvedAmount.toFixed(2)} (edited after approval)`);
    }
    e.status = "paid";
    return { paid: e.amount, expense: e };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[expensedesk] fatal error:", err);
  process.exit(1);
});
