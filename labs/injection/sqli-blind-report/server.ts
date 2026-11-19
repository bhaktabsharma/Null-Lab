/**
 * SearchPortal — Blind Boolean Report Filter
 *
 * GET /reports?min_price=<value> runs a raw, string-concatenated NUMERIC
 * query (no quotes required to break out of anything):
 *
 *   SELECT COUNT(*) as cnt FROM products WHERE price > ${min_price}
 *
 * The response only ever says "matches found" or "no matches" — never
 * row data, never the SQL error text. This is a genuinely blind
 * injection point.
 *
 * The verifier is both structural AND behavioral, checked honestly
 * against what actually happened: (1) the attacker's raw input must
 * reference the hidden `vault` table — something no legitimate numeric
 * price filter would ever contain — and (2) the REAL query, executed
 * against the REAL database, must REALLY return a true/matching result.
 * Mentioning "vault" with a subquery that evaluates to false does not
 * solve it; only a genuinely true injected boolean condition does.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, openInstanceDb, renderShell, escapeHtml } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const db = openInstanceDb(ctx);

db.exec(`
  CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL, category TEXT);
  CREATE TABLE vault (id INTEGER PRIMARY KEY, note TEXT);
`);
const insertProduct = db.prepare("INSERT INTO products (name, price, category) VALUES (?, ?, ?)");
for (const [name, price, category] of [
  ["Mechanical Keyboard (TKL)", 129.99, "keyboards"],
  ["Ergonomic Office Chair", 899.0, "chairs"],
  ["27in 4K Monitor", 412.5, "monitors"],
  ["Studio Headphones", 179.0, "audio"],
] as [string, number, string][]) {
  insertProduct.run(name, price, category);
}
db.prepare("INSERT INTO vault (note) VALUES (?)").run(`internal pricing memo ${ctx.instanceId.slice(0, 8)}`);

function shell(title: string, body: string) {
  return renderShell(title, body, { appName: "SearchPortal", accent: "#c97fd1", navLinks: [{ href: "/reports", label: "Sales Report" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: "SearchPortal" });

  app.get("/", async (_req, reply) => reply.redirect("/reports"));

  // --- The vulnerable handler -------------------------------------------------
  app.get("/reports", async (req, reply) => {
    const raw = String((req.query as { min_price?: string }).min_price ?? "50");

    // VULNERABLE: raw numeric concatenation, no validation, no binding.
    const sql = `SELECT COUNT(*) as cnt FROM products WHERE price > ${raw}`;

    let cnt = 0;
    let queryError = false;
    try {
      const result = db.prepare(sql).get() as { cnt: number };
      cnt = result.cnt;
    } catch {
      queryError = true; // the page deliberately does not reveal the error text — it's blind
    }

    const matched = !queryError && cnt > 0;
    const referencesVault = raw.toLowerCase().includes("vault");

    // Both the structural signal (input references the hidden table) AND
    // the real, honestly-observed behavioral result (the query genuinely
    // matched) must hold.
    if (referencesVault && matched) {
      await reportSolve(
        ctx,
        `GET /reports?min_price=${encodeURIComponent(raw)} executed "${sql}" — a boolean subquery against the hidden vault table evaluated true`,
      );
    }

    reply.type("text/html");
    return shell(
      "Sales Report",
      `<div class="panel">
        <h1>Sales Report — Price Filter</h1>
        <form method="get" action="/reports">
          <p class="muted">Show whether any products are priced above:</p>
          <p><input type="text" name="min_price" value="${escapeHtml(raw)}" /></p>
          <button type="submit">Check</button>
        </form>
        <div class="panel" style="background:#0b0e13;margin-top:1rem;">
          ${queryError ? `<p>Unable to run that filter.</p>` : matched ? `<p><strong>Matches found.</strong></p>` : `<p>No matches.</p>`}
        </div>
      </div>`,
    );
  });

  await startLabApp(app, ctx, "SearchPortal");
}

main().catch((err) => {
  console.error("[searchportal-blind] fatal error:", err);
  process.exit(1);
});
