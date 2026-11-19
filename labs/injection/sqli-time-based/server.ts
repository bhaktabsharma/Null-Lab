/**
 * PulseCheck — Slow Answers (time-based blind SQL injection)
 *
 * POST /subscribe concatenates the email into a query but always returns the
 * same page, swallowing results and errors — only response TIME can differ.
 * The database exposes a capped sleep function. The solve is the correct admin
 * PIN submitted to the unlock form: the PIN exists only in the database and is
 * different per instance, so it has to be genuinely extracted. Unlock attempts
 * are limited so it can't be brute-forced.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, openInstanceDb, renderShell, escapeHtml, seededSecret, boundedSleepMs } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const db = openInstanceDb(ctx);
const APP = "PulseCheck";
const PIN = seededSecret(ctx, "admin-pin", 6, "0123456789");
const MAX_WRONG = 10;
let wrong = 0;

db.function("sleep_ms", (ms: unknown) => boundedSleepMs(Number(ms)));
db.exec(`
  CREATE TABLE subscribers (id INTEGER PRIMARY KEY, email TEXT);
  CREATE TABLE settings (key TEXT, value TEXT);
`);
db.prepare("INSERT INTO subscribers (email) VALUES (?)").run("reader@example.test");
db.prepare("INSERT INTO subscribers (email) VALUES (?)").run("editor@example.test");
db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("admin_pin", PIN);

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#ff9d4d", navLinks: [{ href: "/", label: "Newsletter" }, { href: "/admin", label: "Admin" }] });
}

const THANKS = `<div class="panel"><p><strong>Thanks!</strong> If that address is on our list you'll get the next issue.</p></div>`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Newsletter",
      `<div class="panel"><h1>PulseCheck weekly</h1><p class="muted">Check whether your address is subscribed.</p>
        <form method="post" action="/subscribe"><p><input type="text" name="email" placeholder="you@example.test" /></p><button type="submit">Check</button></form></div>`,
    );
  });

  // --- The vulnerable handler: identical answer every time; only timing differs. --
  app.post("/subscribe", async (req, reply) => {
    const email = String((req.body as { email?: unknown } | null)?.email ?? "");
    try {
      // VULNERABLE: concatenated, and the result is deliberately discarded.
      db.prepare(`SELECT COUNT(*) AS c FROM subscribers WHERE email = '${email}'`).get();
    } catch {
      /* swallowed — the page never reveals errors */
    }
    reply.type("text/html");
    return shell("Thanks", THANKS);
  });

  app.get("/admin", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Admin",
      `<div class="panel"><h1>Admin console</h1><p class="muted">Enter the 6-digit PIN. After ${MAX_WRONG} wrong attempts this console locks until the lab is reset.</p>
        <form method="post" action="/admin/unlock"><p><input type="text" name="pin" inputmode="numeric" /></p><button type="submit">Unlock</button></form></div>`,
    );
  });

  app.post("/admin/unlock", async (req, reply) => {
    reply.type("text/html");
    if (wrong >= MAX_WRONG) {
      reply.code(429);
      return shell("Locked", `<div class="panel"><h1>Locked</h1><p>Too many wrong attempts. Reset the lab to try again.</p></div>`);
    }
    const pin = String((req.body as { pin?: unknown } | null)?.pin ?? "");
    if (pin === PIN) {
      await reportSolve(ctx, `the admin PIN was submitted to /admin/unlock after ${wrong} wrong attempt(s) — it can only have been extracted from the database`);
      return shell("Unlocked", `<div class="panel"><h1>Console unlocked</h1><p class="muted">Synthetic admin console. Nothing here is real.</p></div>`);
    }
    wrong++;
    reply.code(403);
    return shell("Wrong PIN", `<div class="panel"><h1>Wrong PIN</h1><p>${escapeHtml(String(MAX_WRONG - wrong))} attempt(s) left.</p></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[pulsecheck] fatal error:", err);
  process.exit(1);
});
