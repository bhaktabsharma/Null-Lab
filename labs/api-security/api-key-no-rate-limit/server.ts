/**
 * KeyVault API — Unlimited Key Checks (missing API rate limiting)
 *
 * POST /api/partners/validate-key checks a short "PK-NNNN" key with no
 * attempt limiting whatsoever. The key space is deliberately small (10,000
 * possibilities) so the absence of a limit is provably exploitable in a
 * bounded, fast loop — not just a theoretical risk. Recorded only after
 * more failed attempts than a reasonable policy (15) would ever allow.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "KeyVault API";
const REAL_KEY = `PK-${seededSecret(ctx, "partner-key", 4, "0123456789")}`;
const REASONABLE_LIMIT = 15;
let failedAttempts = 0;

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#e0a85c", navLinks: [{ href: "/", label: "Docs" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "KeyVault API",
      `<div class="panel"><h1>KeyVault API</h1><p class="muted">POST /api/partners/validate-key with JSON {"key": "PK-NNNN"} to check a partner key.</p></div>`,
    );
  });

  // --- The vulnerable handler: no attempt limit at all. ------------------------
  app.post("/api/partners/validate-key", async (req, reply) => {
    const key = String((req.body as { key?: unknown } | null)?.key ?? "");
    if (key === REAL_KEY) {
      if (failedAttempts > REASONABLE_LIMIT) {
        await reportSolve(ctx, `the valid partner key was found after ${failedAttempts} failed attempts with no rate limit at any point`);
      }
      return { valid: true };
    }
    failedAttempts++;
    return reply.code(401).send({ valid: false });
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[keyvault-api] fatal error:", err);
  process.exit(1);
});
