/**
 * Bookly — Refer a Friend (reward triggered by the wrong event)
 *
 * The rules: "You earn $10 when your friend's first order is PAID." The reward is
 * granted the moment the friend's first order is CREATED — before any payment — and is
 * never taken back when that order is cancelled. Recorded only when an order is
 * cancelled after having triggered a reward and the friend never paid for anything.
 */
import { randomBytes } from "node:crypto";
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Bookly";
const REWARD_CENTS = 1000;

interface User {
  username: string;
  password: string;
  displayName: string;
  refCode: string;
  referredBy?: string;
  creditCents: number;
}
const USERS: User[] = [{ username: "alice", password: "practice123", displayName: "Alice Chen", refCode: "ALICE-7QX2", creditCents: 0 }];
interface Order {
  id: string;
  owner: string;
  title: string;
  status: "pending" | "paid" | "cancelled";
  rewardGranted: boolean;
}
const orders: Order[] = [];

const sessions = makeSessions<{ user: string }>(ctx, "bookly_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#bd93f9",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/account", label: "Account" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }, { href: "/register", label: "Register" }],
  });

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const me = await (await fetch("/api/me")).json();
  document.getElementById("me").innerHTML = "Your referral code: <strong>" + esc(me.refCode) + "</strong> — credit $" + (me.creditCents / 100).toFixed(2);
  const o = await (await fetch("/api/orders")).json();
  document.getElementById("rows").innerHTML = o.orders.map(function (x) {
    const acts = x.status === "pending" ? '<button onclick="act(\\'' + x.id + "', 'pay')\\">Pay</button> <button onclick=\\"act('" + x.id + "', 'cancel')\\">Cancel</button>" : "";
    return "<tr><td>" + esc(x.id) + "</td><td>" + esc(x.title) + "</td><td>" + esc(x.status) + "</td><td>" + acts + "</td></tr>";
  }).join("");
}
async function order() {
  await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: document.getElementById("t").value || "Paperback" }) });
  load();
}
async function act(id, what) { await fetch("/api/orders/" + id + "/" + what, { method: "POST" }); load(); }
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (USERS.find((u) => u.username === s.user) ?? null) : null;
  };
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/account", demoLine: "Demo account: <strong>alice</strong> / practice123 — or <a href='/register'>register</a>" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/account" : "/login"));

  app.get("/register", async (req, reply) => {
    const ref = (req.query as { ref?: string } | undefined)?.ref ?? "";
    reply.type("text/html");
    return shell("Register", `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Create an account</h1>
      <p><input id="u" placeholder="Username" /></p><p><input id="p" type="password" placeholder="Password" /></p>
      <p><input id="r" placeholder="Referral code (optional)" value="${ref.replace(/[^A-Za-z0-9-]/g, "")}" /></p>
      <button onclick="go()">Register</button> <span id="m" class="muted"></span></div>
      <script>async function go(){ const r = await fetch("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: document.getElementById("u").value, password: document.getElementById("p").value, ref: document.getElementById("r").value || undefined }) });
      if (r.ok) location.href = "/account"; else document.getElementById("m").textContent = (await r.json()).error; }</script>`);
  });
  app.post("/api/register", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown; ref?: unknown };
    if (typeof b.username !== "string" || !/^[a-z0-9_-]{3,20}$/i.test(b.username)) return reply.code(400).send({ error: "username must be 3-20 letters, digits, - or _" });
    if (typeof b.password !== "string" || b.password.length < 6) return reply.code(400).send({ error: "password must be at least 6 characters" });
    if (USERS.some((x) => x.username.toLowerCase() === (b.username as string).toLowerCase())) return reply.code(409).send({ error: "that username is taken" });
    let referrer: User | undefined;
    if (b.ref !== undefined) {
      referrer = USERS.find((x) => x.refCode === b.ref);
      if (!referrer) return reply.code(404).send({ error: "unknown referral code" });
    }
    USERS.push({ username: b.username, password: b.password, displayName: b.username, refCode: `${b.username.toUpperCase().slice(0, 5)}-${randomBytes(2).toString("hex").toUpperCase()}`, referredBy: referrer?.username, creditCents: 0 });
    sessions.set(reply, { user: b.username });
    return { user: { username: b.username } };
  });

  app.get("/account", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Account", `<div class="panel"><h1>Your account</h1><p id="me"></p>
      <p><input id="t" placeholder="Book title" /> <button onclick="order()">Place order</button></p>
      <table><tr><th>Order</th><th>Title</th><th>Status</th><th></th></tr><tbody id="rows"></tbody></table></div><script>${PAGE_SCRIPT}</script>`, u.displayName);
  });
  app.get("/api/me", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { username: u.username, refCode: u.refCode, creditCents: u.creditCents };
  });
  app.get("/api/orders", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { orders: orders.filter((o) => o.owner === u.username) };
  });

  // --- Reward is granted at CREATION of the friend's first order, not at payment. ---
  app.post("/api/orders", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const title = String((req.body as { title?: unknown } | undefined)?.title ?? "Paperback").slice(0, 60);
    const order: Order = { id: `b-${randomBytes(3).toString("hex")}`, owner: u.username, title, status: "pending", rewardGranted: false };
    const firstOrder = !orders.some((o) => o.owner === u.username);
    if (firstOrder && u.referredBy) {
      const referrer = USERS.find((x) => x.username === u.referredBy);
      if (referrer) {
        referrer.creditCents += REWARD_CENTS;
        order.rewardGranted = true;
      }
    }
    orders.push(order);
    return { order };
  });
  app.post("/api/orders/:id/pay", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const o = orders.find((x) => x.id === (req.params as { id: string }).id && x.owner === u.username);
    if (!o) return reply.code(404).send({ error: "no such order" });
    if (o.status !== "pending") return reply.code(409).send({ error: `order is already ${o.status}` });
    o.status = "paid";
    return { order: o };
  });
  app.post("/api/orders/:id/cancel", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const o = orders.find((x) => x.id === (req.params as { id: string }).id && x.owner === u.username);
    if (!o) return reply.code(404).send({ error: "no such order" });
    if (o.status !== "pending") return reply.code(409).send({ error: `order is already ${o.status}` });
    o.status = "cancelled"; // the reward is never reversed
    const everPaid = orders.some((x) => x.owner === u.username && x.status === "paid");
    if (o.rewardGranted && !everPaid) {
      await reportSolve(ctx, `"${u.referredBy}" keeps a ${REWARD_CENTS / 100}-dollar referral reward for "${u.username}", whose first order ${o.id} was cancelled and who never paid for anything`);
    }
    return { order: o };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[bookly] fatal error:", err);
  process.exit(1);
});
