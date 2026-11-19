/**
 * ShelfSort — Sort Order Injection (ORDER BY / column-selection SQL injection)
 *
 * GET /books?sort=<expr> is concatenated into `ORDER BY ${sort}`. UNION
 * cannot be appended there, errors are hidden, and no vault data is ever
 * selected — but a conditional sort key makes the ORDER of the rows depend
 * on a subquery. The solve is the claim code submitted to /claim: it exists
 * only in the hidden table and differs per instance, so it has to be extracted.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, openInstanceDb, renderShell, escapeHtml, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const db = openInstanceDb(ctx);
const APP = "ShelfSort";
const CODE = seededSecret(ctx, "claim-code", 6);
const MAX_WRONG = 10;
let wrong = 0;

db.exec(`
  CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author TEXT, price REAL);
  CREATE TABLE vault (id INTEGER PRIMARY KEY, code TEXT);
`);
const ins = db.prepare("INSERT INTO books (title, author, price) VALUES (?, ?, ?)");
for (const [t, a, p] of [
  ["Algorithms Unlocked", "T. Cormen", 29.99],
  ["Binary Gardens", "L. Okoye", 59.0],
  ["Cipher Notes", "R. Almeida", 12.5],
  ["Debug Diaries", "H. Kim", 34.0],
  ["Entropy", "S. Varga", 45.0],
] as [string, string, number][]) {
  ins.run(t, a, p);
}
db.prepare("INSERT INTO vault (code) VALUES (?)").run(CODE);

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#a0e86b", navLinks: [{ href: "/books", label: "Books" }, { href: "/claim", label: "Claim" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  app.get("/", async (_req, reply) => reply.redirect("/books"));

  // --- The vulnerable handler -------------------------------------------------
  app.get("/books", async (req, reply) => {
    const sort = String((req.query as { sort?: string }).sort ?? "title");
    let rows: { title: string; author: string; price: number }[] = [];
    let failed = false;
    try {
      // VULNERABLE: the sort expression is concatenated into ORDER BY.
      rows = db.prepare(`SELECT title, author, price FROM books ORDER BY ${sort}`).all() as typeof rows;
    } catch {
      failed = true; // errors are never shown
    }
    reply.type("text/html");
    return shell(
      "Books",
      `<div class="panel"><h1>Books</h1>
        <p class="muted">Sort by: <a class="link" href="/books?sort=title">title</a> · <a class="link" href="/books?sort=author">author</a> · <a class="link" href="/books?sort=price">price</a></p>
        ${
          failed
            ? `<p>Could not sort the list that way.</p>`
            : `<table><tr><th>Title</th><th>Author</th><th>Price</th></tr>${rows
                .map((r) => `<tr><td>${escapeHtml(r.title)}</td><td>${escapeHtml(r.author)}</td><td>${r.price.toFixed(2)}</td></tr>`)
                .join("")}</table>`
        }</div>`,
    );
  });

  app.get("/claim", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Claim",
      `<div class="panel"><h1>Claim your reward</h1><p class="muted">Enter the claim code. After ${MAX_WRONG} wrong attempts claiming locks until the lab is reset.</p>
        <form method="post" action="/claim"><p><input type="text" name="code" /></p><button type="submit">Claim</button></form></div>`,
    );
  });

  app.post("/claim", async (req, reply) => {
    reply.type("text/html");
    if (wrong >= MAX_WRONG) {
      reply.code(429);
      return shell("Locked", `<div class="panel"><h1>Locked</h1><p>Too many wrong attempts. Reset the lab to try again.</p></div>`);
    }
    const code = String((req.body as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
    if (code === CODE) {
      await reportSolve(ctx, `the vault claim code was submitted after ${wrong} wrong attempt(s) — it can only have been extracted from the hidden table`);
      return shell("Claimed", `<div class="panel"><h1>Reward claimed</h1><p class="muted">Synthetic reward. Nothing real here.</p></div>`);
    }
    wrong++;
    reply.code(403);
    return shell("Wrong code", `<div class="panel"><h1>Wrong code</h1><p>${MAX_WRONG - wrong} attempt(s) left.</p></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[shelfsort] fatal error:", err);
  process.exit(1);
});
