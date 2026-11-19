/**
 * Brightcart — Order Refunds (duplicate refund processing under concurrency)
 *
 * Refunds are protected two ways: an Idempotency-Key header (a retry with the same key
 * returns the first result) and a "cannot refund more than was paid" check against the
 * order's refunded total. One after the other, both work. But the endpoint checks first,
 * calls the card network (slow), and only THEN records the refunded total and the key —
 * so requests that overlap all see the order as untouched. Recorded only when the
 * refunded total of an order really exceeds what the customer paid.
 */
import { randomBytes } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Brightcart";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
interface Order {
  id: string;
  owner: string;
  item: string;
  totalCents: number;
  refundedCents: number;
}
const ORDERS: Order[] = [
  { id: "o-1001", owner: "alice", item: "Trail runner shoes", totalCents: 8000, refundedCents: 0 },
  { id: "o-1002", owner: "alice", item: "Insulated bottle", totalCents: 4500, refundedCents: 0 },
];
const processed = new Map<string, { orderId: string; amountCents: number; refundId: string }>();

const sessions = makeSessions<{ user: string }>(ctx, "brightcart_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#8be9fd",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/orders", label: "Orders" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const d = await (await fetch("/api/orders")).json();
  document.getElementById("rows").innerHTML = d.orders.map(function (o) {
    return "<tr><td>" + esc(o.id) + "</td><td>" + esc(o.item) + "</td><td>$" + (o.totalCents / 100).toFixed(2) + "</td><td>$" + (o.refundedCents / 100).toFixed(2) +
      '</td><td><input id="a-' + o.id + '" size=6 placeholder="amount" /> <button onclick="refund(\\'' + o.id + '\\')">Refund</button></td></tr>';
  }).join("");
}
async function refund(id) {
  const amount = Number(document.getElementById("a-" + id).value);
  const r = await fetch("/api/orders/" + id + "/refund", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ amount: amount }) });
  document.getElementById("msg").textContent = r.ok ? "Refund issued." : (await r.json()).error;
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/orders", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/orders" : "/login"));

  app.get("/orders", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Orders", `<div class="panel"><h1>Your orders</h1><p class="muted" id="msg"></p>
      <table><tr><th>Order</th><th>Item</th><th>Paid</th><th>Refunded</th><th></th></tr><tbody id="rows"></tbody></table></div><script>${PAGE_SCRIPT}</script>`, "Alice Chen");
  });

  app.get("/api/orders", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { orders: ORDERS.filter((o) => o.owner === u) };
  });

  app.post("/api/orders/:id/refund", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const order = ORDERS.find((o) => o.id === (req.params as { id: string }).id && o.owner === u);
    if (!order) return reply.code(404).send({ error: "no such order" });
    const key = String(req.headers["idempotency-key"] ?? "");
    if (key.length < 8 || key.length > 64) return reply.code(400).send({ error: "an Idempotency-Key header of 8-64 characters is required" });
    const prior = processed.get(key);
    if (prior) {
      if (prior.orderId !== order.id) return reply.code(409).send({ error: "that Idempotency-Key was used for a different order" });
      return { refund: { id: prior.refundId, amount: prior.amountCents / 100 }, replayed: true, order: { refundedCents: order.refundedCents } };
    }
    const amount = (req.body as { amount?: unknown } | undefined)?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return reply.code(400).send({ error: "amount must be a positive number" });
    const cents = Math.round(amount * 100);
    if (cents > order.totalCents - order.refundedCents) return reply.code(409).send({ error: `exceeds the refundable amount (${usd(order.totalCents - order.refundedCents)} left)` });

    await sleep(300); // card network round trip

    const refundId = `re_${randomBytes(4).toString("hex")}`;
    order.refundedCents += cents; // recorded only after the network call...
    processed.set(key, { orderId: order.id, amountCents: cents, refundId }); // ...and so is the key
    if (order.refundedCents > order.totalCents) {
      await reportSolve(ctx, `order ${order.id} was refunded ${usd(order.refundedCents)} although the customer paid ${usd(order.totalCents)} — overlapping refund requests all passed the same pre-network checks`);
    }
    return { refund: { id: refundId, amount: cents / 100 }, order: { refundedCents: order.refundedCents } };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[brightcart] fatal error:", err);
  process.exit(1);
});
