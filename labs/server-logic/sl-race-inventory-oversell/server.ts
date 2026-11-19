/**
 * QuickCart — Last One in Stock (race condition / TOCTOU inventory oversell)
 *
 * POST /order checks `stock > 0`, then — after an awaited gap standing in
 * for a real database round trip — decrements it. Concurrent orders can
 * each observe stock as available before either decrement lands. The 60ms
 * gap is deliberately generous so a realistic concurrent burst reliably
 * lands inside it. Recorded only when MORE orders have actually succeeded
 * than the starting stock allowed.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "QuickCart";
const STARTING_STOCK = 1;
let stock = STARTING_STOCK;
let successfulOrders = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#ffb454", navLinks: [{ href: "/", label: "Shop" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Shop",
      `<div class="panel"><h1>Limited edition mug</h1><p>In stock: ${stock}</p>
        <form method="post" action="/order"><button type="submit">Order now</button></form></div>`,
    );
  });

  // --- The vulnerable handler: check, await, then decrement — a real race window. --
  app.post("/order", async (_req, reply) => {
    reply.type("text/html");
    if (stock <= 0) {
      reply.code(409);
      return shell("Out of stock", `<div class="panel"><p>Sorry, this item is out of stock.</p></div>`);
    }
    await sleep(60); // VULNERABLE: the check-then-decrement gap.
    stock -= 1;
    successfulOrders += 1;
    if (successfulOrders > STARTING_STOCK) {
      await reportSolve(ctx, `${successfulOrders} orders succeeded for an item that started with only ${STARTING_STOCK} unit(s) in stock`);
    }
    return shell("Order placed", `<div class="panel"><p>Order #${successfulOrders} placed. Remaining stock: ${stock}.</p></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[quickcart-inventory] fatal error:", err);
  process.exit(1);
});
