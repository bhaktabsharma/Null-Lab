/**
 * QuickCart — One-Time Coupon (race condition / TOCTOU)
 *
 * POST /coupons/redeem checks whether the coupon was already used, then —
 * after an AWAITED gap standing in for a real database round trip — marks
 * it used. In Node's single-threaded event loop, a real race window only
 * opens at an actual await point; this delay (60ms) is deliberately
 * generous so that a realistic burst of concurrent requests (a handful,
 * sent together) reliably lands inside it, exactly the way PortSwigger's
 * own race-condition labs are built. Recorded only when the coupon is
 * ACTUALLY applied more than once (not merely attempted).
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "QuickCart";
const COUPON_CODE = "WELCOME10";
const DISCOUNT_USD = 10;

let couponUsed = false;
let timesApplied = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#ffb454", navLinks: [{ href: "/", label: "Coupon" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Coupon",
      `<div class="panel"><h1>Apply a coupon</h1><p class="muted">Times applied so far: ${timesApplied}.</p>
        <form method="post" action="/coupons/redeem"><p><input type="text" name="code" value="${COUPON_CODE}" /></p><button type="submit">Redeem</button></form></div>`,
    );
  });

  // --- The vulnerable handler: check, await, then set — a real race window. ---
  app.post("/coupons/redeem", async (req, reply) => {
    const code = String((req.body as { code?: unknown } | null)?.code ?? "");
    reply.type("text/html");
    if (code !== COUPON_CODE) {
      reply.code(400);
      return shell("Invalid", `<div class="panel"><p>Unknown coupon code.</p></div>`);
    }
    if (couponUsed) {
      reply.code(409);
      return shell("Already used", `<div class="panel"><p>This coupon has already been used.</p></div>`);
    }
    await sleep(60); // VULNERABLE: the check-then-set gap. In a real app this would be a DB round trip.
    couponUsed = true;
    timesApplied++;
    if (timesApplied > 1) {
      await reportSolve(ctx, `the single-use coupon "${COUPON_CODE}" was applied ${timesApplied} times via overlapping concurrent requests`);
    }
    return shell("Applied", `<div class="panel"><p>Applied $${DISCOUNT_USD.toFixed(2)} off. (Application #${timesApplied})</p></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[quickcart-coupon] fatal error:", err);
  process.exit(1);
});
