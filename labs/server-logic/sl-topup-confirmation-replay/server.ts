/**
 * Walletly — Top Up (a valid payment confirmation can be replayed)
 *
 * Starting a top-up returns a transaction id and a signed confirmation token. The
 * confirm endpoint — what a payment provider's callback would hit — verifies the
 * signature and the owner and credits the wallet. It never records that the
 * transaction has been confirmed, so the same confirmation credits again every time
 * it is sent. Recorded only when one transaction has credited the wallet more than once.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Walletly";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
let balance = 0;
const txs = new Map<string, { owner: string; amountCents: number; credits: number }>();
const sign = (txId: string, amountCents: number) => createHmac("sha256", ctx.instanceToken).update(`${txId}|${amountCents}`).digest("hex").slice(0, 32);

const sessions = makeSessions<{ user: string }>(ctx, "walletly_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#50fa7b",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/wallet", label: "Wallet" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() { const w = await (await fetch("/api/wallet")).json(); document.getElementById("bal").textContent = "Balance: $" + (w.balanceCents / 100).toFixed(2); }
async function topup() {
  const amount = Number(document.getElementById("amt").value);
  const start = await (await fetch("/api/topups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: amount }) })).json();
  if (!start.txId) { document.getElementById("msg").textContent = start.error; return; }
  // In production the payment provider calls this; here the page does it after the "payment".
  const done = await fetch("/api/topups/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txId: start.txId, amountCents: start.amountCents, token: start.token }) });
  document.getElementById("msg").textContent = done.ok ? "Top-up complete." : (await done.json()).error;
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/wallet", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/wallet" : "/login"));
  app.get("/wallet", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Wallet", `<div class="panel"><h1>Your wallet</h1><p id="bal"></p>
      <p><input id="amt" type="number" min="1" max="500" value="10" /> <button onclick="topup()">Top up</button> <span id="msg" class="muted"></span></p></div><script>${PAGE_SCRIPT}</script>`, "Alice Chen");
  });
  app.get("/api/wallet", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    return { balanceCents: balance };
  });

  app.post("/api/topups", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const amount = (req.body as { amount?: unknown } | undefined)?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 1 || amount > 500) return reply.code(400).send({ error: "amount must be between 1 and 500" });
    const cents = Math.round(amount * 100);
    const txId = `tx-${randomBytes(4).toString("hex")}`;
    txs.set(txId, { owner: u, amountCents: cents, credits: 0 });
    return { txId, amountCents: cents, token: sign(txId, cents) };
  });

  app.post("/api/topups/confirm", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const b = (req.body ?? {}) as { txId?: unknown; amountCents?: unknown; token?: unknown };
    const tx = typeof b.txId === "string" ? txs.get(b.txId) : undefined;
    if (!tx || tx.owner !== u) return reply.code(404).send({ error: "unknown transaction" });
    if (b.amountCents !== tx.amountCents) return reply.code(400).send({ error: "amount does not match the transaction" });
    const expected = Buffer.from(sign(b.txId as string, tx.amountCents));
    const given = Buffer.from(String(b.token ?? ""));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return reply.code(400).send({ error: "invalid confirmation token" });
    balance += tx.amountCents; // never recorded as consumed
    tx.credits++;
    if (tx.credits > 1) {
      await reportSolve(ctx, `transaction ${b.txId} (${usd(tx.amountCents)}) has credited the wallet ${tx.credits} times — the confirmation can be replayed`);
    }
    return { balanceCents: balance };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[walletly] fatal error:", err);
  process.exit(1);
});
