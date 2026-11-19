/**
 * Sendwise — Send Money (a transfer that credits before it debits)
 *
 * A transfer is two steps. The code credits the recipient first and then debits the
 * sender; if the debit is refused for insufficient funds the request fails with a 402 —
 * but the credit has already happened and is never undone. Recorded only when the total
 * money held across all accounts is higher than it started: funds were created.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Sendwise";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

const USERS = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "bob", password: "Bob-Sendwise!22", displayName: "Bob Marsh" },
  { username: "carol", password: "Carol-Sendwise!23", displayName: "Carol Reyes" },
];
const balances = new Map<string, number>([["alice", 10000], ["bob", 2000], ["carol", 5000]]);
const INITIAL_TOTAL = 17000;
const total = () => [...balances.values()].reduce((a, b) => a + b, 0);

const sessions = makeSessions<{ user: string }>(ctx, "sendwise_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#8be9fd",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/send", label: "Send money" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
async function load() { const a = await (await fetch("/api/account")).json(); document.getElementById("bal").textContent = "Balance: $" + (a.balanceCents / 100).toFixed(2); }
async function send() {
  const r = await fetch("/api/transfers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: document.getElementById("to").value, amount: Number(document.getElementById("amt").value) }) });
  document.getElementById("msg").textContent = r.ok ? "Sent." : (await r.json()).error;
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/send", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/send" : "/login"));
  app.get("/send", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Send money", `<div class="panel"><h1>Send money</h1><p id="bal"></p>
      <p><input id="to" placeholder="Recipient username" /> <input id="amt" type="number" step="0.01" placeholder="Amount" /> <button onclick="send()">Send</button> <span id="msg" class="muted"></span></p></div><script>${PAGE_SCRIPT}</script>`, USERS.find((x) => x.username === u)?.displayName);
  });
  app.get("/api/account", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { username: u, balanceCents: balances.get(u) };
  });

  app.post("/api/transfers", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const b = (req.body ?? {}) as { to?: unknown; amount?: unknown };
    if (typeof b.to !== "string" || !balances.has(b.to)) return reply.code(404).send({ error: "no such recipient" });
    if (b.to === u) return reply.code(400).send({ error: "you cannot send money to yourself" });
    if (typeof b.amount !== "number" || !Number.isFinite(b.amount) || b.amount <= 0 || b.amount > 100000) return reply.code(400).send({ error: "amount must be a positive number" });
    const cents = Math.round(b.amount * 100);

    balances.set(b.to, balances.get(b.to)! + cents); // step 1: credit the recipient
    const refused = balances.get(u)! < cents;
    if (!refused) balances.set(u, balances.get(u)! - cents); // step 2: debit the sender (when affordable)

    // The invariant is checked after EVERY transfer, whichever way it went: a correct system never
    // holds more money than it was given. Only a half-completed transfer can break it.
    if (total() > INITIAL_TOTAL) {
      await reportSolve(ctx, `after a transfer of ${usd(cents)} from "${u}" to "${b.to}" (${refused ? "refused for insufficient funds" : "completed"}) the system holds ${usd(total())} instead of ${usd(INITIAL_TOTAL)} — the credit was applied and never undone`);
    }
    if (refused) return reply.code(402).send({ error: "insufficient funds" });
    return { balanceCents: balances.get(u) };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[sendwise] fatal error:", err);
  process.exit(1);
});
