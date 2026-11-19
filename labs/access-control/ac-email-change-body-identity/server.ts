/**
 * Parcelo — Update Your Contact Details (unauthorized email / phone modification)
 *
 * Reading an account is protected correctly (you only ever get your own). The
 * contact-update endpoint has an "integrity check" — but it compares the account
 * id in the URL with a `userId` field in the request BODY, both supplied by the
 * client, instead of with the signed-in session. Recorded only when the contact
 * details of an account other than the caller's own are really changed.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, CLIENT_ESC_JS } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Parcelo";

interface Account {
  id: number;
  username: string;
  password: string;
  displayName: string;
  email: string;
  phone: string;
}
const ACCOUNTS: Account[] = [
  { id: 1001, username: "alice", password: "practice123", displayName: "Alice Chen", email: "alice@parcelo-mail.example", phone: "+1 555 0101" },
  { id: 1002, username: "dana", password: "Dana-Parcelo!55", displayName: "Dana Whitfield", email: "dana@parcelo-mail.example", phone: "+1 555 0102" },
  { id: 1003, username: "ben", password: "Ben-Parcelo!56", displayName: "Ben Hollis", email: "ben@parcelo-mail.example", phone: "+1 555 0103" },
];

const sessions = makeSessions<{ user: string }>(ctx, "parcelo_session");

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, {
    appName: APP,
    accent: "#f1fa8c",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/account", label: "My account" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });
}

const PAGE_SCRIPT = `
${CLIENT_ESC_JS}
let me = null;
async function load() {
  me = await (await fetch("/api/me")).json();
  const acct = await (await fetch("/api/accounts/" + me.id)).json();
  document.getElementById("email").value = acct.account.email;
  document.getElementById("phone").value = acct.account.phone;
  document.getElementById("who").textContent = acct.account.displayName + " (account " + acct.account.id + ")";
}
document.getElementById("f").addEventListener("submit", async function (e) {
  e.preventDefault();
  const res = await fetch("/api/accounts/" + me.id + "/contact", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: me.id, email: document.getElementById("email").value, phone: document.getElementById("phone").value })
  });
  document.getElementById("msg").textContent = res.ok ? "Saved." : (await res.json()).error;
});
load();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const account = (req: Parameters<typeof sessions.read>[0]) => {
    const s = sessions.read(req);
    return s ? (ACCOUNTS.find((a) => a.username === s.user) ?? null) : null;
  };

  registerPasswordLogin(app, { users: ACCOUNTS, sessions, shell, appName: APP, home: "/account", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(account(req) ? "/account" : "/login"));

  app.get("/account", async (req, reply) => {
    const a = account(req);
    if (!a) return reply.redirect("/login");
    reply.type("text/html");
    return shell(
      "My account",
      `<div class="panel"><h1>Contact details</h1><p class="muted" id="who"></p>
        <form id="f">
          <p><label>Email<br /><input id="email" type="email" required /></label></p>
          <p><label>Phone<br /><input id="phone" /></label></p>
          <button type="submit">Save</button> <span id="msg" class="muted"></span>
        </form></div>
      <script>${PAGE_SCRIPT}</script>`,
      a.displayName,
    );
  });

  app.get("/api/me", async (req, reply) => {
    const a = account(req);
    if (!a) return reply.code(401).send({ error: "login required" });
    return { id: a.id, username: a.username };
  });

  // Correctly protected: you can only read your own account.
  app.get("/api/accounts/:id", async (req, reply) => {
    const a = account(req);
    if (!a) return reply.code(401).send({ error: "login required" });
    const id = Number((req.params as { id: string }).id);
    if (id !== a.id) return reply.code(403).send({ error: "you can only view your own account" });
    return { account: { id: a.id, displayName: a.displayName, email: a.email, phone: a.phone } };
  });

  // --- The vulnerable handler ---------------------------------------------------
  app.patch("/api/accounts/:id/contact", async (req, reply) => {
    const caller = account(req);
    if (!caller) return reply.code(401).send({ error: "login required" });
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { userId?: unknown; email?: unknown; phone?: unknown };
    // "Integrity check": the id being edited must match the userId in the form.
    // Both come from the client; the session identity is never consulted.
    if (Number(body.userId) !== id) return reply.code(403).send({ error: "userId does not match the account being edited" });
    const target = ACCOUNTS.find((x) => x.id === id);
    if (!target) return reply.code(404).send({ error: "no such account" });
    if (body.email === undefined && body.phone === undefined) return reply.code(400).send({ error: "nothing to update" });
    if (body.email !== undefined && (typeof body.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email))) return reply.code(422).send({ error: "invalid email address" });
    if (body.phone !== undefined && (typeof body.phone !== "string" || !/^\+?[0-9 ()-]{7,20}$/.test(body.phone))) return reply.code(422).send({ error: "invalid phone number" });

    const before = { email: target.email, phone: target.phone };
    if (typeof body.email === "string") target.email = body.email;
    if (typeof body.phone === "string") target.phone = body.phone;
    const changed = target.email !== before.email || target.phone !== before.phone;
    if (changed && target.id !== caller.id) {
      await reportSolve(ctx, `"${caller.username}" changed the contact details of account ${target.id} ("${target.username}"): email ${before.email} -> ${target.email}, phone ${before.phone} -> ${target.phone}`);
    }
    return { account: { id: target.id, email: target.email, phone: target.phone } };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[parcelo] fatal error:", err);
  process.exit(1);
});
