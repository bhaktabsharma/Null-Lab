/**
 * Mercato — Instant Refund to Wallet (refund initiated on someone else's order)
 *
 * Delivered orders can be refunded to the shopper's store wallet in one click. The
 * endpoint checks the order exists, was delivered and was not already refunded —
 * and credits the wallet of WHOEVER CALLS IT. It never checks the order is theirs.
 * Recorded only when a wallet is credited from an order belonging to a different user.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Mercato";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

const USERS = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "dana", password: "Dana-Mercato!11", displayName: "Dana Whitfield" },
];
const wallet = new Map<string, number>([["alice", 0], ["dana", 1500]]);
interface Order {
  id: string;
  owner: string;
  item: string;
  totalCents: number;
  status: "pending" | "delivered" | "refunded";
}
const ORDERS: Order[] = [
  { id: "o-3001", owner: "dana", item: "Noise-cancelling headphones", totalCents: 24900, status: "delivered" },
  { id: "o-3002", owner: "dana", item: "Desk lamp", totalCents: 5900, status: "delivered" },
  { id: "o-3003", owner: "alice", item: "Yoga mat", totalCents: 3500, status: "delivered" },
  { id: "o-3004", owner: "alice", item: "Water filter", totalCents: 1200, status: "pending" },
];

const sessions = makeSessions<{ user: string }>(ctx, "mercato_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#50fa7b",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/orders", label: "Orders" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const d = await (await fetch("/api/orders")).json();
  const w = await (await fetch("/api/wallet")).json();
  document.getElementById("wallet").textContent = "Wallet balance: $" + (w.balanceCents / 100).toFixed(2);
  document.getElementById("rows").innerHTML = d.orders.map(function (o) {
    const btn = o.status === "delivered" ? '<button onclick="refund(\\'' + o.id + '\\')">Refund to wallet</button>' : "";
    return "<tr><td>" + esc(o.id) + "</td><td>" + esc(o.item) + "</td><td>$" + (o.totalCents / 100).toFixed(2) + "</td><td>" + esc(o.status) + "</td><td>" + btn + "</td></tr>";
  }).join("");
}
async function refund(id) {
  const r = await fetch("/api/orders/" + id + "/refund-to-wallet", { method: "POST" });
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
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Orders", `<div class="panel"><h1>Your orders</h1><p class="muted" id="wallet"></p>
      <table><tr><th>Order</th><th>Item</th><th>Total</th><th>Status</th><th></th></tr><tbody id="rows"></tbody></table></div><script>${PAGE_SCRIPT}</script>`, USERS.find((x) => x.username === u)?.displayName);
  });
  app.get("/api/orders", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { orders: ORDERS.filter((o) => o.owner === u) };
  });
  app.get("/api/wallet", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { balanceCents: wallet.get(u) ?? 0 };
  });

  // --- Vulnerable: eligibility is checked, ownership is not; the CALLER is credited. ---
  app.post("/api/orders/:id/refund-to-wallet", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const order = ORDERS.find((o) => o.id === (req.params as { id: string }).id);
    if (!order) return reply.code(404).send({ error: "no such order" });
    if (order.status === "refunded") return reply.code(409).send({ error: "this order was already refunded" });
    if (order.status !== "delivered") return reply.code(409).send({ error: "only delivered orders can be refunded to the wallet" });
    order.status = "refunded";
    wallet.set(u, (wallet.get(u) ?? 0) + order.totalCents);
    if (order.owner !== u) {
      await reportSolve(ctx, `"${u}" refunded order ${order.id} (${usd(order.totalCents)}, belongs to "${order.owner}") into their own wallet`);
    }
    return { refundedCents: order.totalCents, balanceCents: wallet.get(u) };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[mercato] fatal error:", err);
  process.exit(1);
});
