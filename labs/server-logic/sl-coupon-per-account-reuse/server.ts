/**
 * Parcelpost — Welcome Offer (a "single-use" code that is only single-use per account)
 *
 * The welcome code says it can be redeemed once. The redemption check asks "has THIS
 * account used it?" instead of "has anyone?", and anyone can register an account.
 * Recorded only when the one-time code has been redeemed by two different accounts.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Parcelpost";

interface User {
  username: string;
  password: string;
  displayName: string;
}
const USERS: User[] = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const wallet = new Map<string, number>([["alice", 0]]);
const COUPON = { code: "NEWBIE5", valueCents: 500, redeemedBy: [] as string[] };

const sessions = makeSessions<{ user: string }>(ctx, "parcelpost_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#ff79c6",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/offers", label: "Offers" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }, { href: "/register", label: "Register" }],
  });

const PAGE_SCRIPT = `
async function load() {
  const w = await (await fetch("/api/wallet")).json();
  document.getElementById("bal").textContent = "Credit balance: $" + (w.balanceCents / 100).toFixed(2);
}
async function redeem() {
  const r = await fetch("/api/coupons/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: document.getElementById("code").value }) });
  document.getElementById("msg").textContent = r.ok ? "Redeemed." : (await r.json()).error;
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/offers", demoLine: "Demo account: <strong>alice</strong> / practice123 — or <a href='/register'>register</a>" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/offers" : "/login"));

  app.get("/register", async (_req, reply) => {
    reply.type("text/html");
    return shell("Register", `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Create an account</h1>
      <p><input id="u" placeholder="Username" /></p><p><input id="p" type="password" placeholder="Password" /></p>
      <button onclick="go()">Register</button> <span id="m" class="muted"></span></div>
      <script>async function go(){ const r = await fetch("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: document.getElementById("u").value, password: document.getElementById("p").value }) });
      if (r.ok) location.href = "/offers"; else document.getElementById("m").textContent = (await r.json()).error; }</script>`);
  });
  app.post("/api/register", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof b.username !== "string" || !/^[a-z0-9_-]{3,20}$/i.test(b.username)) return reply.code(400).send({ error: "username must be 3-20 letters, digits, - or _" });
    if (typeof b.password !== "string" || b.password.length < 6) return reply.code(400).send({ error: "password must be at least 6 characters" });
    if (USERS.some((x) => x.username.toLowerCase() === (b.username as string).toLowerCase())) return reply.code(409).send({ error: "that username is taken" });
    USERS.push({ username: b.username, password: b.password, displayName: b.username });
    wallet.set(b.username, 0);
    sessions.set(reply, { user: b.username });
    return { user: { username: b.username } };
  });

  app.get("/offers", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Offers", `<div class="panel"><h1>Welcome offer</h1><p class="muted">Code <strong>${COUPON.code}</strong> gives $5.00 credit. This offer can be redeemed once.</p>
      <p id="bal"></p><p><input id="code" placeholder="Enter code" /> <button onclick="redeem()">Redeem</button> <span id="msg" class="muted"></span></p></div><script>${PAGE_SCRIPT}</script>`, u);
  });
  app.get("/api/wallet", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { balanceCents: wallet.get(u) ?? 0 };
  });

  app.post("/api/coupons/redeem", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const code = String((req.body as { code?: unknown } | undefined)?.code ?? "").toUpperCase();
    if (code !== COUPON.code) return reply.code(404).send({ error: "unknown code" });
    if (COUPON.redeemedBy.includes(u)) return reply.code(409).send({ error: "you have already redeemed this code" }); // per account, not per code
    COUPON.redeemedBy.push(u);
    wallet.set(u, (wallet.get(u) ?? 0) + COUPON.valueCents);
    if (COUPON.redeemedBy.length > 1) {
      await reportSolve(ctx, `the one-time code ${COUPON.code} has now been redeemed by ${COUPON.redeemedBy.length} accounts: ${COUPON.redeemedBy.join(", ")}`);
    }
    return { creditedCents: COUPON.valueCents, balanceCents: wallet.get(u) };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[parcelpost] fatal error:", err);
  process.exit(1);
});
