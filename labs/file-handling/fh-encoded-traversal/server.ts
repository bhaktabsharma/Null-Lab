/**
 * DocuDrop — Blocked, But Only Once (URL-encoded / double-encoded traversal)
 *
 * The filter rejects a literal "../" in the raw query string — but Fastify's
 * query parser decodes the parameter once before the handler sees it, and
 * this handler ALSO applies one decodeURIComponent() pass of its own before
 * using the value (a common, well-intentioned mistake: "normalize, then
 * validate" done in the wrong order). A payload encoded twice therefore
 * still contains "%2e%2e%2f" — not literal "../" — when the filter runs,
 * survives it, and only becomes "../" after the handler's own decode.
 * Simulated filesystem only; see mini-vfs.ts. Recorded only when the content
 * returned lives outside the receipts directory.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, MiniVfs } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "DocuDrop";
const RECEIPTS_DIR = "/app/receipts";

const vfs = new MiniVfs({
  "/app/receipts/2026-09-invoice.txt": "Receipt #4471 — Coffee subscription — $12.00",
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
    return shell("Your receipts", `<div class="panel"><h1>Your receipts</h1><ul>${files.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul></div>`);
  });

  // --- The vulnerable handler --------------------------------------------------
  app.get("/download", async (req, reply) => {
    // Fastify has already URL-decoded this once (standard query-string parsing).
    const onceDecoded = String((req.query as { file?: string }).file ?? "");
    reply.type("text/plain");
    if (!onceDecoded) {
      reply.code(400);
      return "Missing file parameter.";
    }
    // VULNERABLE ORDER: the filter runs BEFORE the handler's own extra decode.
    if (onceDecoded.includes("../")) {
      reply.code(400);
      return "Invalid filename.";
    }
    let file = onceDecoded;
    try {
      file = decodeURIComponent(onceDecoded); // a second decode pass, applied too late to be checked
    } catch {
      /* not re-encoded; use as-is */
    }
    const path = `${RECEIPTS_DIR}/${file}`;
    const entry = vfs.read(path);
    if (!entry) {
      reply.code(404);
      return "File not found.";
    }
    const resolved = vfs.normalize(path);
    if (!vfs.isUnder(RECEIPTS_DIR, resolved)) {
      await reportSolve(ctx, `GET /download?file=${onceDecoded} (literal text never contained "../") returned the content of "${resolved}"`);
    }
    return entry.content;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[docudrop-encoded] fatal error:", err);
  process.exit(1);
});
