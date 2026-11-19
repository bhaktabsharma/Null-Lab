/**
 * Bagelry — Promo Codes (coupon stacking through separate slots)
 *
 * The page promises "one discount per order, 30% at most". Each code endpoint enforces
 * that for ITS OWN slot — one promo code, one loyalty code — and nothing compares the
 * two. Checkout simply adds the percentages. Recorded only when an order is really
 * placed with a combined discount above the 30% policy limit.
 */
import { randomBytes } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Bagelry";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const MAX_PCT = 30;

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const PROMOS: Record<string, number> = { PROMO25: 25, WELCOME10: 10 };
const LOYALTY: Record<string, number> = { LOYAL20: 20 };
const SUBTOTAL = 10000;
const cart = { items: [{ name: "Dozen bagels", unitCents: 2500, qty: 4 }], promo: null as string | null, loyalty: null as string | null };
const orders: { id: string; totalCents: number; discountPct: number; promo: string | null; loyalty: string | null }[] = [];

const sessions = makeSessions<{ user: string }>(ctx, "bagelry_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#f1fa8c",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/cart", label: "Cart" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const c = await (await fetch("/api/cart")).json();
  document.getElementById("cart").innerHTML = "Subtotal $" + (c.subtotalCents / 100).toFixed(2) + " — promo: " + esc(c.promo || "none") + " — loyalty: " + esc(c.loyalty || "none") +
    "<br>You pay $" + (c.totalCents / 100).toFixed(2) + " (" + c.discountPct + "% off)";
}
async function apply(kind) {
  const code = document.getElementById(kind).value;
  const r = await fetch("/api/cart/" + kind, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code }) });
  document.getElementById("msg").textContent = r.ok ? "Applied." : (await r.json()).error;
  load();
}
async function checkout() {
  const r = await fetch("/api/checkout", { method: "POST" });
  document.getElementById("msg").textContent = r.ok ? "Order placed." : (await r.json()).error;
  load();
}
load();
`;

const pct = () => (cart.promo ? PROMOS[cart.promo]! : 0) + (cart.loyalty ? LOYALTY[cart.loyalty]! : 0);
const total = () => Math.round(SUBTOTAL * (1 - Math.min(pct(), 100) / 100));

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/cart", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/cart" : "/login"));
  app.get("/cart", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Cart", `<div class="panel"><h1>Your basket</h1><p id="cart"></p>
      <p class="muted">One discount per order. Maximum ${MAX_PCT}% off.</p>
      <p><input id="promo" placeholder="Promo code" /> <button onclick="apply('promo')">Apply</button></p>
      <p><input id="loyalty" placeholder="Loyalty reward code" /> <button onclick="apply('loyalty')">Apply</button></p>
      <p><button onclick="checkout()">Check out</button> <span id="msg" class="muted"></span></p></div><script>${PAGE_SCRIPT}</script>`, "Alice Chen");
  });
  app.get("/api/cart", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    return { items: cart.items, subtotalCents: SUBTOTAL, promo: cart.promo, loyalty: cart.loyalty, discountPct: pct(), totalCents: total() };
  });
  app.get("/api/rewards", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    return { rewards: [{ code: "LOYAL20", note: "Thanks for being a regular — 20% off your next basket." }] };
  });

  const slot = (kind: "promo" | "loyalty", table: Record<string, number>) => async (req: any, reply: any) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    const code = String((req.body as { code?: unknown } | undefined)?.code ?? "").toUpperCase();
    if (cart[kind]) return reply.code(409).send({ error: `a ${kind} code is already applied` }); // checks its own slot only
    if (!(code in table)) return reply.code(404).send({ error: "unknown code" });
    cart[kind] = code;
    return { discountPct: pct(), totalCents: total() };
  };
  app.post("/api/cart/promo", slot("promo", PROMOS));
  app.post("/api/cart/loyalty", slot("loyalty", LOYALTY));

  app.post("/api/checkout", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    const order = { id: `o-${randomBytes(3).toString("hex")}`, totalCents: total(), discountPct: pct(), promo: cart.promo, loyalty: cart.loyalty };
    orders.push(order);
    cart.promo = null;
    cart.loyalty = null;
    if (order.discountPct > MAX_PCT) {
      await reportSolve(ctx, `an order was placed for ${usd(order.totalCents)} with ${order.discountPct}% off (promo ${order.promo}, loyalty ${order.loyalty}) — above the ${MAX_PCT}% policy limit`);
    }
    return { order };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[bagelry] fatal error:", err);
  process.exit(1);
});
