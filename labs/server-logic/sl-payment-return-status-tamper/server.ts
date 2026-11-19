/**
 * Tix — Checkout Return (payment verification that signs the wrong fields)
 *
 * Paying redirects the browser to a mock card processor, which sends it back to the
 * shop with ?order, ?amount, ?status and a signature. The shop verifies the signature
 * — which covers the order and amount but NOT the status — and then believes the status
 * in the URL. A declined payment's redirect therefore carries a signature that is just
 * as valid for "paid". Recorded only when an order is marked paid although the
 * processor's own record says it was declined.
 */
import { createHmac } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Tix";

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
interface Order {
  id: string;
  title: string;
  amountCents: number;
  status: "awaiting_payment" | "paid" | "payment_failed";
}
const orders: Order[] = [{ id: "t-501", title: "Concert tickets x2 — Row F", amountCents: 18000, status: "awaiting_payment" }];
const processorRecord = new Map<string, "paid" | "declined">(); // the processor's own truth

const sessions = makeSessions<{ user: string }>(ctx, "tix_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#8be9fd",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/orders", label: "My orders" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

// The signature covers order and amount — not status.
const sign = (order: string, amount: number) => createHmac("sha256", ctx.instanceToken).update(`${order}|${amount}`).digest("hex").slice(0, 32);

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/orders", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/orders" : "/login"));

  app.get("/orders", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    const rows = orders.map((o) => `<tr><td>${o.id}</td><td>${o.title}</td><td>$${(o.amountCents / 100).toFixed(2)}</td><td>${o.status}</td><td>${o.status === "paid" ? "" : `<a href="/pay/${o.id}">Pay now</a>`}</td></tr>`).join("");
    return shell("My orders", `<div class="panel"><h1>My orders</h1><table><tr><th>Order</th><th>Items</th><th>Amount</th><th>Status</th><th></th></tr>${rows}</table></div>`, "Alice Chen");
  });

  // --- The "card processor" (a separate service in real life) -------------------------
  app.get("/pay/:orderId", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    const o = orders.find((x) => x.id === (req.params as { orderId: string }).orderId);
    reply.type("text/html");
    if (!o) return reply.code(404).send(shell("Pay", `<div class="panel"><h1>Unknown order</h1></div>`));
    return shell("Secure payment", `<div class="panel" style="max-width:420px;margin:2rem auto;"><h1>PayGate</h1><p class="muted">Paying $${(o.amountCents / 100).toFixed(2)} for ${o.title}</p>
      <form method="post" action="/pay/${o.id}"><p><select name="card"><option value="4242424242424242">4242 4242 4242 4242 (test: succeeds)</option><option value="4000000000000002">4000 0000 0000 0002 (test: declined)</option></select></p><button>Pay</button></form></div>`);
  });
  app.post("/pay/:orderId", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    const o = orders.find((x) => x.id === (req.params as { orderId: string }).orderId);
    if (!o) return reply.code(404).send({ error: "unknown order" });
    const card = String((req.body as { card?: unknown } | undefined)?.card ?? "");
    const status = card === "4242424242424242" ? "paid" : "declined";
    processorRecord.set(o.id, status);
    return reply.redirect(`/checkout/return?order=${o.id}&amount=${o.amountCents}&status=${status}&sig=${sign(o.id, o.amountCents)}`);
  });

  // --- The shop's return handler ---------------------------------------------------------
  app.get("/checkout/return", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    const q = req.query as { order?: string; amount?: string; status?: string; sig?: string };
    const o = orders.find((x) => x.id === q.order);
    if (!o) return reply.code(404).send({ error: "unknown order" });
    const amount = Number(q.amount);
    if (!Number.isInteger(amount) || amount !== o.amountCents) return reply.code(400).send({ error: "amount does not match the order" });
    if (q.sig !== sign(o.id, amount)) return reply.code(400).send({ error: "invalid signature" });
    if (o.status === "paid") return reply.code(409).send({ error: "order is already paid" });
    if (q.status === "paid") {
      o.status = "paid";
      if (processorRecord.get(o.id) !== "paid") {
        await reportSolve(ctx, `order ${o.id} was marked paid although the card processor's record for it is "${processorRecord.get(o.id) ?? "none"}" — the return URL's status parameter was trusted and is not covered by its signature`);
      }
    } else {
      o.status = "payment_failed";
    }
    return reply.redirect("/orders");
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[tix] fatal error:", err);
  process.exit(1);
});
