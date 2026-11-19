/**
 * ParcelTrack — Verbose Errors (error-based SQL injection)
 *
 * The tracking query concatenates the reference into SQL. The page prints
 * only a fixed status label, so UNION-style output is useless — but raw
 * database errors are returned to the client, and the database exposes a
 * `checked_int()` helper whose error echoes its argument (as an integer
 * cast does on some engines). An injected subquery passed to that helper
 * therefore leaks through the error text.
 *
 * Recorded only when an error response actually contains the secret.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, openInstanceDb, renderShell, escapeHtml, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const db = openInstanceDb(ctx);
const APP = "ParcelTrack";
const API_KEY = `KEY-${seededSecret(ctx, "staff-api-key", 10)}`;

// Integer validation with a PostgreSQL-style error that echoes the offending value.
db.function("checked_int", (v: unknown) => {
  if (v === null) return null;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  const s = String(v);
  if (/^-?\d+$/.test(s.trim())) return Number(s);
  throw new Error(`invalid input syntax for type integer: "${s}"`);
});

db.exec(`
  CREATE TABLE parcels (id INTEGER PRIMARY KEY, ref TEXT, status TEXT, weight_grams INTEGER);
  CREATE TABLE staff (id INTEGER PRIMARY KEY, username TEXT, api_key TEXT);
`);
const ins = db.prepare("INSERT INTO parcels (ref, status, weight_grams) VALUES (?, ?, ?)");
ins.run("NL-1001", "in_transit", 1200);
ins.run("NL-1002", "delivered", 450);
ins.run("NL-1003", "out_for_delivery", 8800);
db.prepare("INSERT INTO staff (username, api_key) VALUES (?, ?)").run("ops", API_KEY);

const LABELS: Record<string, string> = {
  in_transit: "In transit",
  delivered: "Delivered",
  out_for_delivery: "Out for delivery",
};

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#4dd2ff", navLinks: [{ href: "/track", label: "Track a parcel" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  app.get("/", async (_req, reply) => reply.redirect("/track"));

  // --- The vulnerable handler -------------------------------------------------
  app.get("/track", async (req, reply) => {
    const ref = (req.query as { ref?: string }).ref;
    let result = "";

    if (ref !== undefined) {
      // VULNERABLE: string concatenation, and the raw error goes back to the client.
      const sql = `SELECT status FROM parcels WHERE ref = '${ref}' AND checked_int(weight_grams) < 30000`;
      try {
        const row = db.prepare(sql).get() as { status: string } | undefined;
        result = row
          ? `<p>Status: <strong>${escapeHtml(LABELS[row.status] ?? "Unknown")}</strong></p>`
          : `<p class="muted">No parcel found with that reference.</p>`;
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes(API_KEY)) {
          await reportSolve(ctx, `GET /track?ref=… returned a database error containing the hidden staff API key: ${message.slice(0, 120)}`);
        }
        reply.code(500);
        result = `<div class="panel" style="background:#0b0e13;"><p><strong>Database error</strong></p>
          <pre>${escapeHtml(message)}</pre><p class="muted">while running:</p><pre>${escapeHtml(sql)}</pre></div>`;
      }
    }

    reply.type("text/html");
    return shell(
      "Track a parcel",
      `<div class="panel">
        <h1>Track a parcel</h1>
        <form method="get" action="/track">
          <p><input type="text" name="ref" placeholder="e.g. NL-1001" value="${escapeHtml(ref ?? "")}" /></p>
          <button type="submit">Track</button>
        </form>
        ${result}
      </div>`,
    );
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[parceltrack] fatal error:", err);
  process.exit(1);
});
