/**
 * SearchPortal — Product Search UNION Injection
 *
 * GET /search?category=<value> runs a genuinely vulnerable, raw
 * string-concatenated SQL query against a real per-instance SQLite
 * database:
 *
 *   SELECT id, name, price, category FROM products WHERE category = '${category}'
 *
 * The `vault` table is never referenced by any legitimate code path in
 * this app — the ONLY way a vault row can appear in the results is a
 * successful UNION SELECT, so detecting a vault row in the real query
 * result is an honest, unambiguous, server-side proof of exploitation
 * (not a string/pattern match on the user's input).
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, openInstanceDb, renderShell, escapeHtml } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const db = openInstanceDb(ctx);

const VAULT_MARKER = `NULLLAB-VAULT-${ctx.instanceId.slice(0, 8)}`;

db.exec(`
  CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL, category TEXT);
  CREATE TABLE vault (id INTEGER PRIMARY KEY, name TEXT, price REAL, category TEXT);
`);

const insertProduct = db.prepare("INSERT INTO products (name, price, category) VALUES (?, ?, ?)");
for (const [name, price, category] of [
  ["Mechanical Keyboard (TKL)", 129.99, "keyboards"],
  ["Compact 60% Keyboard", 89.5, "keyboards"],
  ["Ergonomic Office Chair", 899.0, "chairs"],
  ["Mesh-Back Task Chair", 249.0, "chairs"],
  ["27in 4K Monitor", 412.5, "monitors"],
  ["34in Ultrawide Monitor", 699.0, "monitors"],
  ["Studio Headphones", 179.0, "audio"],
  ["Desktop Speakers (pair)", 95.0, "audio"],
] as [string, number, string][]) {
  insertProduct.run(name, price, category);
}
db.prepare("INSERT INTO vault (name, price, category) VALUES (?, 0, 'classified')").run(VAULT_MARKER);

const CATEGORIES = ["keyboards", "chairs", "monitors", "audio"];

function shell(title: string, body: string) {
  return renderShell(title, body, {
    appName: "SearchPortal",
    accent: "#c97fd1",
    navLinks: [{ href: "/", label: "Search" }],
  });
}

async function main() {
  const app = await createLabApp(ctx, { appName: "SearchPortal" });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "SearchPortal",
      `<div class="panel">
        <h1>Search products by category</h1>
        <p class="muted">Try: ${CATEGORIES.map((c) => `<a class="link" href="/search?category=${c}">${escapeHtml(c)}</a>`).join(", ")}</p>
        <form method="get" action="/search">
          <p><input type="text" name="category" placeholder="e.g. keyboards" /></p>
          <button type="submit">Search</button>
        </form>
      </div>`,
    );
  });

  // --- The vulnerable handler -------------------------------------------------
  app.get("/search", async (req, reply) => {
    const category = String((req.query as { category?: string }).category ?? "");

    // VULNERABLE: raw string concatenation into a SQL query, no
    // parameter binding whatsoever. This is the actual, real query that
    // actually executes against a real SQLite database.
    const sql = `SELECT id, name, price, category FROM products WHERE category = '${category}'`;

    let rows: { id: number; name: string; price: number; category: string }[] = [];
    let queryError: string | null = null;
    try {
      rows = db.prepare(sql).all() as typeof rows;
    } catch (err) {
      // A real (if slightly verbose) SQLite error — part of what makes
      // error-based injection discoverable, but NOT itself a solve.
      queryError = (err as Error).message;
    }

    // Honest, server-side check against REAL query results: the `vault`
    // table is never reachable through any legitimate path, so a row
    // carrying our per-instance marker can only appear via a real UNION.
    const leaked = rows.find((r) => r.name === VAULT_MARKER);
    if (leaked) {
      await reportSolve(
        ctx,
        `GET /search?category=${encodeURIComponent(category)} executed "${sql}" and returned a row from the vault table (marker ${VAULT_MARKER}) via UNION SELECT`,
      );
    }

    reply.type("text/html");
    return shell(
      "Search results",
      `<div class="panel">
        <h1>Results for category "${escapeHtml(category)}"</h1>
        ${queryError ? `<p class="muted" style="color:#e07a7a;">Database error: ${escapeHtml(queryError)}</p>` : ""}
        <table>
          <tr><th>ID</th><th>Name</th><th>Price</th><th>Category</th></tr>
          ${rows
            .map(
              (r) =>
                `<tr><td>${r.id}</td><td>${escapeHtml(r.name)}</td><td>$${Number(r.price).toFixed(2)}</td><td>${escapeHtml(r.category)}</td></tr>`,
            )
            .join("")}
        </table>
        ${rows.length === 0 && !queryError ? `<p class="muted">No products in that category.</p>` : ""}
        <p><a class="link" href="/">&larr; New search</a></p>
      </div>`,
    );
  });

  await startLabApp(app, ctx, "SearchPortal");
}

main().catch((err) => {
  console.error("[searchportal-search] fatal error:", err);
  process.exit(1);
});
