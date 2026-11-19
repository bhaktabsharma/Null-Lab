/**
 * QuickCart — Your Price, As Submitted (business-logic: client-trusted price)
 *
 * POST /checkout takes `unitPriceUsd` directly from the request body
 * instead of looking the real price up server-side from the catalog.
 * Recorded only when a real order for the featured product is placed at a
 * unit price below the catalog's actual price.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "QuickCart";
const PRODUCT = { id: "standing-desk", name: "Standing desk", realPriceUsd: 1200 };
const orders: { productId: string; unitPriceUsd: number; total: number }[] = [];

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#ffb454", navLinks: [{ href: "/", label: "Shop" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Shop",
      `<div class="panel"><h1>${escapeHtml(PRODUCT.name)} — $${PRODUCT.realPriceUsd}</h1>
        <form method="post" action="/checkout">
          <input type="hidden" name="productId" value="${PRODUCT.id}" />
          <input type="hidden" name="unitPriceUsd" value="${PRODUCT.realPriceUsd}" />
          <p>Quantity: <input type="number" name="quantity" value="1" min="1" /></p>
          <button type="submit">Buy now</button></form></div>`,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.post("/checkout", async (req, reply) => {
    const b = (req.body ?? {}) as { productId?: unknown; unitPriceUsd?: unknown; quantity?: unknown };
    const quantity = Number(b.quantity);
    const unitPriceUsd = Number(b.unitPriceUsd); // VULNERABLE: trusted verbatim, never looked up
    reply.type("text/html");
    if (b.productId !== PRODUCT.id || !Number.isInteger(quantity) || quantity < 1 || quantity > 20 || !Number.isFinite(unitPriceUsd) || unitPriceUsd < 0 || unitPriceUsd > 100000) {
      reply.code(400);
      return shell("Invalid", `<div class="panel"><p>Invalid order.</p></div>`);
    }
    const total = unitPriceUsd * quantity;
    orders.push({ productId: PRODUCT.id, unitPriceUsd, total });

    if (unitPriceUsd < PRODUCT.realPriceUsd) {
      await reportSolve(ctx, `an order for "${PRODUCT.id}" was placed at unit price $${unitPriceUsd.toFixed(2)}, below the catalog price of $${PRODUCT.realPriceUsd.toFixed(2)}`);
    }
    return shell("Order placed", `<div class="panel"><p>Ordered ${quantity} × ${escapeHtml(PRODUCT.name)} at $${unitPriceUsd.toFixed(2)} each.</p><p>Total: <strong>$${total.toFixed(2)}</strong></p></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[quickcart-price] fatal error:", err);
  process.exit(1);
});
