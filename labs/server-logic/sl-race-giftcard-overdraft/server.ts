/**
 * QuickCart — Gift Card Balance (race condition / TOCTOU overdraft)
 *
 * POST /giftcard/withdraw checks `balance >= amount`, then — after an
 * awaited gap standing in for a real database round trip — deducts it.
 * Concurrent requests can each observe the same pre-deduction balance and
 * all be approved. The 60ms gap is deliberately generous so a realistic
 * burst of concurrent requests reliably lands inside it. Recorded only when
 * the TOTAL amount actually withdrawn exceeds the card's starting balance.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "QuickCart";
const STARTING_BALANCE = 50;
let balance = STARTING_BALANCE;
let totalWithdrawn = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#ffb454", navLinks: [{ href: "/", label: "Gift card" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Gift card",
      `<div class="panel"><h1>Gift card</h1><p>Current balance: $${balance.toFixed(2)} (started at $${STARTING_BALANCE.toFixed(2)})</p>
        <form method="post" action="/giftcard/withdraw"><p>Amount: <input type="number" name="amount" value="20" /></p><button type="submit">Withdraw</button></form></div>`,
    );
  });

  // --- The vulnerable handler: check, await, then deduct — a real race window. --
  app.post("/giftcard/withdraw", async (req, reply) => {
    const amount = Number((req.body as { amount?: unknown } | null)?.amount);
    reply.type("text/html");
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) {
      reply.code(400);
      return shell("Invalid", `<div class="panel"><p>Invalid amount.</p></div>`);
    }
    if (amount > balance) {
      reply.code(409);
      return shell("Insufficient balance", `<div class="panel"><p>Insufficient balance.</p></div>`);
    }
    await sleep(60); // VULNERABLE: the check-then-deduct gap.
    balance -= amount;
    totalWithdrawn += amount;
    if (totalWithdrawn > STARTING_BALANCE) {
      await reportSolve(ctx, `total withdrawn ($${totalWithdrawn.toFixed(2)}) exceeded the gift card's starting balance ($${STARTING_BALANCE.toFixed(2)}) via overlapping concurrent withdrawals`);
    }
    return shell("Withdrawn", `<div class="panel"><p>Withdrew $${amount.toFixed(2)}. Remaining balance: $${balance.toFixed(2)}. Total withdrawn so far: $${totalWithdrawn.toFixed(2)}.</p></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[quickcart-giftcard] fatal error:", err);
  process.exit(1);
});
