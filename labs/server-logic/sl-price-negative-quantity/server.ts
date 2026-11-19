/**
 * QuickCart — Negative Quantities (business-logic: unchecked sign)
 *
 * POST /order computes `total = price * quantity` with no check that
 * quantity is a positive integer. Recorded only when a real order is placed
 * whose computed total is <= 0.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "QuickCart";
const PRODUCT = { name: "Desk lamp", priceUsd: 45 };
const orders: { quantity: number; total: number }[] = [];

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#ffb454", navLinks: [{ href: "/", label: "Shop" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Shop",
      `<div class="panel"><h1>${escapeHtml(PRODUCT.name)} — $${PRODUCT.priceUsd}</h1>
        <form method="post" action="/order"><p>Quantity: <input type="number" name="quantity" value="1" /></p><button type="submit">Place order</button></form></div>`,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.post("/order", async (req, reply) => {
    const b = (req.body ?? {}) as { quantity?: unknown };
    const quantity = Number(b.quantity);
    reply.type("text/html");
    if (!Number.isInteger(quantity)) {
      reply.code(400);
      return shell("Invalid", `<div class="panel"><p>Quantity must be a whole number.</p></div>`);
    }
    // VULNERABLE: no check that quantity > 0.
    const total = PRODUCT.priceUsd * quantity;
    orders.push({ quantity, total });

    if (total <= 0) {
      await reportSolve(ctx, `an order for quantity ${quantity} was placed with a computed total of $${total.toFixed(2)}`);
    }
    return shell("Order placed", `<div class="panel"><p>Ordered ${quantity} × ${escapeHtml(PRODUCT.name)}.</p><p>Total: <strong>$${total.toFixed(2)}</strong></p></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[quickcart-negative] fatal error:", err);
  process.exit(1);
});
