/**
 * Cartly — Return an Item (refund computed from list price, not from what was paid)
 *
 * Returns are checked sensibly: the line must exist, quantities cannot exceed what is
 * still returnable, and each unit can only come back once. The refund amount, though,
 * is list price x quantity — the order-level discount that reduced what the customer
 * actually paid is never applied. Recorded only when the total refunded on an order
 * exceeds the amount the customer paid.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Cartly";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
interface Line {
  id: string;
  name: string;
  unitCents: number;
  qty: number;
  returned: number;
}
interface Order {
  id: string;
  owner: string;
  coupon: string | null;
  paidCents: number;
  refundedCents: number;
  lines: Line[];
}
const ORDERS: Order[] = [
  {
    id: "o-2001", owner: "alice", coupon: "HALF50 (50% off)", paidCents: 5000, refundedCents: 0,
    lines: [{ id: "l1", name: "Wool coat", unitCents: 6000, qty: 1, returned: 0 }, { id: "l2", name: "Scarf", unitCents: 4000, qty: 1, returned: 0 }],
  },
  { id: "o-2002", owner: "alice", coupon: null, paidCents: 5000, refundedCents: 0, lines: [{ id: "l1", name: "Mug set", unitCents: 2500, qty: 2, returned: 0 }] },
];

const sessions = makeSessions<{ user: string }>(ctx, "cartly_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#ffb86c",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/orders", label: "Orders" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const d = await (await fetch("/api/orders")).json();
  document.getElementById("orders").innerHTML = d.orders.map(function (o) {
    const lines = o.lines.map(function (l) {
      return "<tr><td>" + esc(l.name) + "</td><td>$" + (l.unitCents / 100).toFixed(2) + "</td><td>" + l.qty + "</td><td>" + l.returned + '</td><td><button onclick="ret(\\'' + o.id + "', '" + l.id + '\\')">Return 1</button></td></tr>';
    }).join("");
    return '<div class="panel"><h2>' + esc(o.id) + "</h2><p class=muted>Paid $" + (o.paidCents / 100).toFixed(2) + (o.coupon ? " after coupon " + esc(o.coupon) : "") + " — refunded so far $" + (o.refundedCents / 100).toFixed(2) +
      "</p><table><tr><th>Item</th><th>List price</th><th>Qty</th><th>Returned</th><th></th></tr>" + lines + "</table></div>";
  }).join("");
}
async function ret(id, lineId) {
  const r = await fetch("/api/orders/" + id + "/returns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lineId: lineId, qty: 1 }) });
  if (!r.ok) alert((await r.json()).error);
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
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Orders", `<div id="orders"></div><script>${PAGE_SCRIPT}</script>`, "Alice Chen");
  });
  app.get("/api/orders", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { orders: ORDERS.filter((o) => o.owner === u) };
  });

  app.post("/api/orders/:id/returns", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const order = ORDERS.find((o) => o.id === (req.params as { id: string }).id && o.owner === u);
    if (!order) return reply.code(404).send({ error: "no such order" });
    const body = (req.body ?? {}) as { lineId?: unknown; qty?: unknown };
    const line = order.lines.find((l) => l.id === body.lineId);
    if (!line) return reply.code(404).send({ error: "no such line" });
    if (typeof body.qty !== "number" || !Number.isInteger(body.qty) || body.qty < 1) return reply.code(400).send({ error: "qty must be a positive whole number" });
    if (body.qty > line.qty - line.returned) return reply.code(409).send({ error: `only ${line.qty - line.returned} left to return on this line` });
    line.returned += body.qty;
    const refund = line.unitCents * body.qty; // list price — the discount is never applied
    order.refundedCents += refund;
    if (order.refundedCents > order.paidCents) {
      await reportSolve(ctx, `order ${order.id} has been refunded ${usd(order.refundedCents)} although the customer paid only ${usd(order.paidCents)} — refunds used list prices and ignored the ${order.coupon ?? "discount"}`);
    }
    return { refundCents: refund, order: { refundedCents: order.refundedCents, paidCents: order.paidCents } };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[cartly] fatal error:", err);
  process.exit(1);
});
