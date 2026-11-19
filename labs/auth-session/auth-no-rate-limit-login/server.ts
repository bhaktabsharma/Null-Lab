/**
 * KioskPanel — No One's Counting (missing rate limit / account lockout)
 *
 * POST /unlock checks a 3-digit PIN against the real one with no attempt
 * limiting whatsoever — no counter, no delay, no lockout. The PIN is
 * deliberately short so the test (and a learner) can exhaustively try all
 * 1000 possibilities in a bounded, fast loop, proving the absence of a
 * control is exploitable in practice. Recorded only after more failed
 * attempts than a reasonable policy (10) would ever have allowed.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "KioskPanel";
const PIN = seededSecret(ctx, "kiosk-pin", 3, "0123456789");
const REASONABLE_LOCKOUT_THRESHOLD = 10;
let failedAttempts = 0;

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#ff9f5b", navLinks: [{ href: "/", label: "Kiosk" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Kiosk",
      `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>KioskPanel</h1><p class="muted">Enter the 3-digit admin PIN to unlock settings.</p>
        <form method="post" action="/unlock"><p><input type="text" name="pin" inputmode="numeric" maxlength="3" /></p><button type="submit">Unlock</button></form></div>`,
    );
  });

  // --- The vulnerable handler: no limit on failed attempts of any kind. --------
  app.post("/unlock", async (req, reply) => {
    const pin = String((req.body as { pin?: unknown } | null)?.pin ?? "");
    reply.type("text/html");
    if (pin === PIN) {
      if (failedAttempts > REASONABLE_LOCKOUT_THRESHOLD) {
        await reportSolve(ctx, `the correct admin PIN was found after ${failedAttempts} failed attempts with no lockout, delay, or CAPTCHA at any point`);
      }
      return shell("Unlocked", `<div class="panel"><h1>Settings unlocked</h1><p class="muted">Synthetic admin settings. Nothing real here.</p></div>`);
    }
    failedAttempts++;
    reply.code(401);
    return shell("Wrong PIN", `<div class="panel" style="max-width:380px;margin:3rem auto;"><p style="color:#e07a7a;">Wrong PIN.</p>
      <form method="post" action="/unlock"><p><input type="text" name="pin" inputmode="numeric" maxlength="3" /></p><button type="submit">Unlock</button></form></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[kioskpanel] fatal error:", err);
  process.exit(1);
});
