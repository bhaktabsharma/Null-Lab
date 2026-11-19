/**
 * Giftly — Move Card Balance (aliasing when the source and destination are the same card)
 *
 * Transferring balance loads both cards, subtracts from one copy, adds to the other,
 * and writes both back. When the "from" and "to" card are the same card the two copies
 * are independent: the second write overwrites the first, the subtraction is lost, and
 * the card ends up with the amount added. Recorded only when the money held on the
 * caller's cards is more than the card issuer put on them.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Giftly";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

const USERS = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "dana", password: "Dana-Giftly!41", displayName: "Dana Whitfield" },
];
interface Card {
  id: string;
  owner: string;
  balanceCents: number;
}
const cards = new Map<string, Card>([
  ["g-100", { id: "g-100", owner: "alice", balanceCents: 5000 }],
  ["g-101", { id: "g-101", owner: "alice", balanceCents: 500 }],
  ["g-200", { id: "g-200", owner: "dana", balanceCents: 20000 }],
]);
const ISSUED_TO_ALICE = 5500;

const sessions = makeSessions<{ user: string }>(ctx, "giftly_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#ff79c6",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/cards", label: "My cards" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
async function load() {
  const d = await (await fetch("/api/giftcards")).json();
  document.getElementById("rows").innerHTML = d.cards.map(function (c) { return "<tr><td>" + esc(c.id) + "</td><td>$" + (c.balanceCents / 100).toFixed(2) + "</td></tr>"; }).join("");
}
async function move() {
  const r = await fetch("/api/giftcards/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fromCard: document.getElementById("f").value, toCard: document.getElementById("t").value, amount: Number(document.getElementById("a").value) }) });
  document.getElementById("msg").textContent = r.ok ? "Moved." : (await r.json()).error;
  load();
}
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/cards", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/cards" : "/login"));
  app.get("/cards", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("My cards", `<div class="panel"><h1>Your gift cards</h1><table><tr><th>Card</th><th>Balance</th></tr><tbody id="rows"></tbody></table>
      <p><input id="f" placeholder="From card" /> <input id="t" placeholder="To card" /> <input id="a" type="number" step="0.01" placeholder="Amount" /> <button onclick="move()">Move balance</button> <span id="msg" class="muted"></span></p></div><script>${PAGE_SCRIPT}</script>`, "Alice Chen");
  });
  app.get("/api/giftcards", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    return { cards: [...cards.values()].filter((c) => c.owner === u) };
  });

  app.post("/api/giftcards/transfer", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.code(401).send({ error: "login required" });
    const b = (req.body ?? {}) as { fromCard?: unknown; toCard?: unknown; amount?: unknown };
    const from = typeof b.fromCard === "string" ? cards.get(b.fromCard) : undefined;
    const to = typeof b.toCard === "string" ? cards.get(b.toCard) : undefined;
    if (!from || from.owner !== u) return reply.code(404).send({ error: "no such card on your account" });
    if (!to) return reply.code(404).send({ error: "no such destination card" });
    if (typeof b.amount !== "number" || !Number.isFinite(b.amount) || b.amount <= 0) return reply.code(400).send({ error: "amount must be a positive number" });
    const cents = Math.round(b.amount * 100);
    if (cents > from.balanceCents) return reply.code(409).send({ error: "insufficient balance on the source card" });

    const f = { ...from }; // independent copies...
    const t = { ...to };
    f.balanceCents -= cents;
    t.balanceCents += cents;
    cards.set(f.id, f);
    cards.set(t.id, t); // ...so when from and to are the same card, this write wins and the subtraction is lost

    const mine = [...cards.values()].filter((c) => c.owner === u).reduce((n, c) => n + c.balanceCents, 0);
    if (u === "alice" && mine > ISSUED_TO_ALICE) {
      await reportSolve(ctx, `"${u}" now holds ${usd(mine)} on their gift cards although only ${usd(ISSUED_TO_ALICE)} was ever issued to them — a transfer from ${f.id} to ${t.id} created money`);
    }
    return { cards: [...cards.values()].filter((c) => c.owner === u) };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[giftly] fatal error:", err);
  process.exit(1);
});
