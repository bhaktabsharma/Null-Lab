/**
 * Fxwallet — Convert Currency (rounding always in the customer's favour)
 *
 * Conversions are done in whole minor units (cents) and the result is rounded UP
 * ("so customers are never short-changed") in both directions, with no fee and a
 * minimum of one cent. Round-tripping tiny amounts therefore gains a little every
 * time. Recorded only when the wallet's total value, counted in USD, has grown by at
 * least $2.00 from conversions alone.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Fxwallet";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const bal = { EUR: 10000, USD: 0 }; // minor units
// EUR -> USD at 1.10, USD -> EUR at 0.91 (percent as integers)
const RATE_PCT = { "EUR:USD": 110, "USD:EUR": 91 } as const;
const valueUsdCents = () => Math.round((bal.EUR * 110) / 100) + bal.USD;
const START_VALUE = valueUsdCents();
const TARGET_GAIN = 200;
let conversions = 0;

const sessions = makeSessions<{ user: string }>(ctx, "fxwallet_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#f1fa8c",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/wallet", label: "Wallet" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
async function load() { const w = await (await fetch("/api/wallet")).json(); document.getElementById("bal").textContent = "EUR " + (w.EUR / 100).toFixed(2) + " · USD " + (w.USD / 100).toFixed(2); }
async function conv() {
  const r = await fetch("/api/convert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: document.getElementById("from").value, to: document.getElementById("to").value, amount: Number(document.getElementById("amt").value) }) });
  document.getElementById("msg").textContent = r.ok ? "Converted." : (await r.json()).error;
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/wallet", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/wallet" : "/login"));
  app.get("/wallet", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Wallet", `<div class="panel"><h1>Multi-currency wallet</h1><p id="bal"></p><p class="muted">Rates: 1 EUR = 1.10 USD · 1 USD = 0.91 EUR · no fees · minimum 0.01</p>
      <p><select id="from"><option>EUR</option><option>USD</option></select> → <select id="to"><option>USD</option><option>EUR</option></select> <input id="amt" type="number" step="0.01" value="0.01" /> <button onclick="conv()">Convert</button> <span id="msg" class="muted"></span></p></div><script>${PAGE_SCRIPT}</script>`, "Alice Chen");
  });
  app.get("/api/wallet", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    return { EUR: bal.EUR, USD: bal.USD };
  });

  app.post("/api/convert", async (req, reply) => {
    if (!who(req)) return reply.code(401).send({ error: "login required" });
    const b = (req.body ?? {}) as { from?: unknown; to?: unknown; amount?: unknown };
    if ((b.from !== "EUR" && b.from !== "USD") || (b.to !== "EUR" && b.to !== "USD") || b.from === b.to) return reply.code(400).send({ error: "from and to must be different currencies (EUR or USD)" });
    if (typeof b.amount !== "number" || !Number.isFinite(b.amount) || b.amount < 0.01) return reply.code(400).send({ error: "minimum conversion is 0.01" });
    const inMinor = Math.round(b.amount * 100);
    const from = b.from as "EUR" | "USD";
    const to = b.to as "EUR" | "USD";
    if (inMinor > bal[from]) return reply.code(409).send({ error: `insufficient ${from} balance` });
    const ratePct = from === "EUR" ? RATE_PCT["EUR:USD"] : RATE_PCT["USD:EUR"];
    const outMinor = Math.ceil((inMinor * ratePct) / 100); // always rounded up
    bal[from] -= inMinor;
    bal[to] += outMinor;
    conversions++;
    const gain = valueUsdCents() - START_VALUE;
    if (gain >= TARGET_GAIN) {
      await reportSolve(ctx, `after ${conversions} conversions (no deposits) the wallet is worth ${usd(valueUsdCents())} instead of ${usd(START_VALUE)} — +${usd(gain)} created by rounding up in the customer's favour`);
    }
    return { inMinor, outMinor, wallet: { EUR: bal.EUR, USD: bal.USD } };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[fxwallet] fatal error:", err);
  process.exit(1);
});
