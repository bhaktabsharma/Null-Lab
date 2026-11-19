/**
 * OrdersAPI — Create Order (API mass assignment)
 *
 * POST /api/orders correctly computes `totalUsd` and a default `status` —
 * but then merges the ORIGINAL request body onto the finished record before
 * storing it, so any field the client already included (even ones the
 * server just computed) wins. Recorded only when the stored order's status
 * is "shipped" or its stored total doesn't match price × quantity — proving
 * a client-supplied value actually overwrote a server-computed one.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "OrdersAPI";
const PRODUCT = { id: "kb-01", name: "Mechanical keyboard", priceUsd: 80 };
interface Order { id: number; productId: string; quantity: number; totalUsd: number; status: string; }
const orders: Order[] = [];
let nextId = 1;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async () => ({ info: "POST /api/orders with JSON {productId, quantity}" }));

  // --- The vulnerable handler --------------------------------------------------
  app.post("/api/orders", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const quantity = Number(body.quantity);
    if (body.productId !== PRODUCT.id || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      return reply.code(400).send({ error: "invalid order" });
    }
    const computed: Order = {
      id: nextId++,
      productId: PRODUCT.id,
      quantity,
      totalUsd: PRODUCT.priceUsd * quantity,
      status: "pending_payment",
    };
    // VULNERABLE: the raw request body is merged back on TOP of the server's own computed values.
    const finalOrder: Order = { ...computed, ...body, id: computed.id } as Order;
    orders.push(finalOrder);

    const expectedTotal = PRODUCT.priceUsd * finalOrder.quantity;
    if (finalOrder.status === "shipped" || finalOrder.totalUsd !== expectedTotal) {
      await reportSolve(ctx, `order ${finalOrder.id} was stored with status="${finalOrder.status}" and totalUsd=${finalOrder.totalUsd} (expected ${expectedTotal}), overwritten by the request body`);
    }
    return reply.code(201).send(finalOrder);
  });

  app.get("/api/orders/:id", async (req, reply) => {
    const order = orders.find((o) => o.id === Number((req.params as { id: string }).id));
    if (!order) return reply.code(404).send({ error: "no such order" });
    return order;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[ordersapi] fatal error:", err);
  process.exit(1);
});
