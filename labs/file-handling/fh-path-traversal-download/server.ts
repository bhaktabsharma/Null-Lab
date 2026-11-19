/**
 * DocuDrop — Download Your Receipt (classic path traversal)
 *
 * GET /download?file= string-concatenates the filename onto the receipts
 * directory with no normalization and no containment check. All "file
 * access" goes through MiniVfs, a fully simulated in-memory filesystem (see
 * lab-sdk/mini-vfs.ts) — this lab never opens a real file descriptor.
 * Recorded only when the content actually returned lives OUTSIDE the
 * receipts directory.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, MiniVfs } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "DocuDrop";
const RECEIPTS_DIR = "/app/receipts";

const vfs = new MiniVfs({
  "/app/receipts/2026-09-invoice.txt": "Receipt #4471 — Coffee subscription — $12.00",
  "/app/receipts/2026-10-invoice.txt": "Receipt #4502 — Coffee subscription — $12.00",
  "/app/internal/db-credentials.txt": "db_host=internal-db.lab\ndb_user=app_service\ndb_password=Sx9#rT2!qLmZ",
});

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#f2a65a", navLinks: [{ href: "/", label: "Receipts" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    const files = vfs.list(RECEIPTS_DIR);
    reply.type("text/html");
    return shell(
      "Your receipts",
      `<div class="panel"><h1>Your receipts</h1><ul>${files.map((f) => `<li><a class="link" href="/download?file=${encodeURIComponent(f)}">${escapeHtml(f)}</a></li>`).join("")}</ul></div>`,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.get("/download", async (req, reply) => {
    const file = String((req.query as { file?: string }).file ?? "");
    reply.type("text/plain");
    if (!file) {
      reply.code(400);
      return "Missing file parameter.";
    }
    // VULNERABLE: plain string concatenation, no normalization or containment check.
    const path = `${RECEIPTS_DIR}/${file}`;
    const entry = vfs.read(path);
    if (!entry) {
      reply.code(404);
      return "File not found.";
    }
    const resolved = vfs.normalize(path);
    if (!vfs.isUnder(RECEIPTS_DIR, resolved)) {
      await reportSolve(ctx, `GET /download?file=${file} returned the content of "${resolved}", outside the receipts directory`);
    }
    return entry.content;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[docudrop] fatal error:", err);
  process.exit(1);
});
