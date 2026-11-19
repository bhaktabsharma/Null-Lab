/**
 * Streamly — Plan Changes (entitlement granted ahead of billing)
 *
 * Switching plan takes effect immediately and nothing is charged until the next
 * renewal, which bills whichever plan the account is on THAT DAY. Pro-only 4K exports
 * check the current plan only. So an account can upgrade, use Pro features, drop back
 * to Basic before renewal, and only ever be billed for Basic. Recorded when a renewal
 * bills less than Pro for a period in which Pro-only features were used.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Streamly";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const PRICE = { basic: 1000, pro: 3000 } as const;
type Plan = keyof typeof PRICE;

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const sub = { plan: "basic" as Plan, proExportsThisPeriod: 0, invoices: [] as { periodBilledPlan: Plan; cents: number }[] };

const sessions = makeSessions<{ user: string }>(ctx, "streamly_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#ff5555",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/billing", label: "Plan & billing" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const s = await (await fetch("/api/subscription")).json();
  document.getElementById("plan").innerHTML = "Current plan: <strong>" + esc(s.plan) + "</strong> — renews at $" + (s.nextInvoiceCents / 100).toFixed(2) + "<br>Invoices: " + (s.invoices.map(function (i) { return "$" + (i.cents / 100).toFixed(2) + " (" + esc(i.periodBilledPlan) + ")"; }).join(", ") || "none yet");
}
async function setPlan(p) { const r = await fetch("/api/subscription/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: p }) }); if (!r.ok) alert((await r.json()).error); load(); }
async function exp(q) { const r = await fetch("/api/exports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quality: q }) }); document.getElementById("msg").textContent = r.ok ? "Export ready." : (await r.json()).error; }
async function renew() { await fetch("/api/billing/advance", { method: "POST" }); load(); }
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/billing", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/billing" : "/login"));
  app.get("/billing", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Plan & billing", `<div class="panel"><h1>Your plan</h1><p id="plan"></p>
      <p><button onclick="setPlan('basic')">Switch to Basic ($10)</button> <button onclick="setPlan('pro')">Switch to Pro ($30)</button></p>
      <p><button onclick="exp('standard')">Export (standard)</button> <button onclick="exp('4k')">Export (4K, Pro only)</button> <span id="msg" class="muted"></span></p>
      <p class="muted">Billing runs on your renewal date. <button onclick="renew()">Advance to next renewal (training aid)</button></p></div><script>${PAGE_SCRIPT}</script>`, "Alice Chen");
  });

  app.get("/api/subscription", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    return { plan: sub.plan, nextInvoiceCents: PRICE[sub.plan], invoices: sub.invoices };
  });

  // Plan changes are immediate; nothing is charged now.
  app.post("/api/subscription/plan", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    const plan = (req.body as { plan?: unknown } | undefined)?.plan;
    if (plan !== "basic" && plan !== "pro") return reply.code(400).send({ error: 'plan must be "basic" or "pro"' });
    sub.plan = plan;
    return { plan: sub.plan, nextInvoiceCents: PRICE[sub.plan] };
  });

  app.post("/api/exports", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    const q = (req.body as { quality?: unknown } | undefined)?.quality;
    if (q !== "standard" && q !== "4k") return reply.code(400).send({ error: 'quality must be "standard" or "4k"' });
    if (q === "4k") {
      if (sub.plan !== "pro") return reply.code(403).send({ error: "4K export needs the Pro plan" });
      sub.proExportsThisPeriod++;
    }
    return { export: { quality: q, url: `/exports/${q}-${Date.now()}.zip` } };
  });

  // The renewal: bills the plan the account is on today.
  app.post("/api/billing/advance", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    const charge = PRICE[sub.plan];
    sub.invoices.push({ periodBilledPlan: sub.plan, cents: charge });
    const used = sub.proExportsThisPeriod;
    sub.proExportsThisPeriod = 0;
    if (used > 0 && charge < PRICE.pro) {
      await reportSolve(ctx, `renewal billed ${usd(charge)} (${sub.plan}) for a period in which ${used} Pro-only 4K export(s) were produced — the plan was switched back before billing`);
    }
    return { invoice: sub.invoices[sub.invoices.length - 1] };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[streamly] fatal error:", err);
  process.exit(1);
});
