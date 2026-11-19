/**
 * Pantrybox — Checkout (a race between two different endpoints)
 *
 * Checkout totals the cart and authorizes the card for that amount — a slow call to the
 * payment gateway — and only afterwards builds the order lines from the cart AS IT IS
 * THEN. The "add to cart" endpoint is not locked during checkout. Each endpoint is
 * correct on its own; a cart change that lands while the card is being authorized ends
 * up in the order without being paid for. Recorded only when an order's items are worth
 * at least $10 more than the amount authorized.
 */
import { randomBytes } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Pantrybox";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const CATALOG: Record<string, { name: string; cents: number }> = {
  "tea-tin": { name: "Loose-leaf tea tin", cents: 1500 },
  "espresso-beans": { name: "Espresso beans 1kg", cents: 2800 },
  "ceramic-pot": { name: "Ceramic teapot", cents: 4500 },
};
let cart: { sku: string; qty: number }[] = [{ sku: "tea-tin", qty: 1 }];
const orders: { id: string; lines: { sku: string; qty: number }[]; authorizedCents: number; itemsCents: number }[] = [];
const cartTotal = (c: { sku: string; qty: number }[]) => c.reduce((n, l) => n + CATALOG[l.sku]!.cents * l.qty, 0);

const sessions = makeSessions<{ user: string }>(ctx, "pantrybox_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#ffb86c",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/cart", label: "Cart" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const c = await (await fetch("/api/cart")).json();
  document.getElementById("cart").innerHTML = (c.lines.map(function (l) { return esc(l.name) + " × " + l.qty; }).join("<br>") || "Your cart is empty") + "<br><strong>Total $" + (c.totalCents / 100).toFixed(2) + "</strong>";
  const o = await (await fetch("/api/orders")).json();
  document.getElementById("orders").innerHTML = o.orders.map(function (x) { return "<li>" + esc(x.id) + " — items $" + (x.itemsCents / 100).toFixed(2) + ", charged $" + (x.authorizedCents / 100).toFixed(2) + "</li>"; }).join("");
}
async function add(sku) { await fetch("/api/cart/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sku: sku, qty: 1 }) }); load(); }
async function checkout() { document.getElementById("msg").textContent = "Authorizing your card…"; const r = await fetch("/api/checkout", { method: "POST" }); document.getElementById("msg").textContent = r.ok ? "Thank you!" : (await r.json()).error; load(); }
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/cart", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/cart" : "/login"));
  app.get("/cart", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Cart", `<div class="panel"><h1>Your cart</h1><p id="cart"></p>
      <p><button onclick="add('tea-tin')">+ Tea tin</button> <button onclick="add('espresso-beans')">+ Espresso beans</button> <button onclick="add('ceramic-pot')">+ Teapot</button></p>
      <p><button onclick="checkout()">Check out</button> <span id="msg" class="muted"></span></p><h2>Orders</h2><ul id="orders"></ul></div><script>${PAGE_SCRIPT}</script>`, "Alice Chen");
  });

  app.get("/api/cart", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    return { lines: cart.map((l) => ({ sku: l.sku, name: CATALOG[l.sku]!.name, qty: l.qty })), totalCents: cartTotal(cart) };
  });
  app.get("/api/orders", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    return { orders };
  });
  app.post("/api/cart/items", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    const b = (req.body ?? {}) as { sku?: unknown; qty?: unknown };
    if (typeof b.sku !== "string" || !(b.sku in CATALOG)) return reply.code(404).send({ error: "unknown product" });
    if (typeof b.qty !== "number" || !Number.isInteger(b.qty) || b.qty < 1 || b.qty > 5) return reply.code(400).send({ error: "qty must be 1-5" });
    const line = cart.find((l) => l.sku === b.sku);
    if (line) line.qty += b.qty;
    else cart.push({ sku: b.sku, qty: b.qty });
    return { totalCents: cartTotal(cart) };
  });

  app.post("/api/checkout", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    if (cart.length === 0) return reply.code(409).send({ error: "your cart is empty" });
    const quoteCents = cartTotal(cart); // 1. total what is in the cart now
    await sleep(450); //                     2. authorize the card (slow gateway call)
    const lines = cart.map((l) => ({ ...l })); // 3. build the order from the cart AS IT IS NOW
    cart = [];
    const order = { id: `o-${randomBytes(3).toString("hex")}`, lines, authorizedCents: quoteCents, itemsCents: cartTotal(lines) };
    orders.push(order);
    if (order.itemsCents - order.authorizedCents >= 1000) {
      await reportSolve(ctx, `order ${order.id} contains ${usd(order.itemsCents)} of items but only ${usd(order.authorizedCents)} was authorized — the cart changed while the card was being authorized`);
    }
    return { order };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[pantrybox] fatal error:", err);
  process.exit(1);
});
