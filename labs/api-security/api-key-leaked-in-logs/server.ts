/**
 * WeatherAPI — Keys in the Open (API key handling mistake: leaked via logs)
 *
 * GET /api/weather?key=... accepts the key as a query parameter "for
 * convenience". A separate, seemingly-harmless /api/request-log endpoint
 * records every request's FULL URL verbatim (as many real access logs do),
 * so any key sent this way ends up readable there — including a more
 * privileged key used elsewhere (simulating another caller's traffic).
 * Recorded only when a request actually succeeds using a key the caller
 * was never issued, recovered from the log.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "WeatherAPI";
const DEMO_KEY = `demo_${seededSecret(ctx, "demo-key", 10)}`;
const INTERNAL_KEY = `internal_${seededSecret(ctx, "internal-key", 10)}`;
const requestLog: { url: string; at: string }[] = [];

// Simulated prior traffic from the "internal-tools" caller, as if it happened moments before this instance was handed to the learner.
requestLog.push({ url: `/api/weather?key=${INTERNAL_KEY}&city=Berlin`, at: new Date(Date.now() - 120_000).toISOString() });

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#5ea8e0", navLinks: [{ href: "/", label: "Docs" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "WeatherAPI",
      `<div class="panel"><h1>WeatherAPI</h1><p class="muted">GET /api/weather?key=${DEMO_KEY}&amp;city=Paris</p>
        <p class="muted">GET /api/request-log — recent request log, for debugging.</p></div>`,
    );
  });

  app.get("/api/weather", async (req, reply) => {
    const key = (req.query as { key?: string }).key;
    requestLog.push({ url: req.url, at: new Date().toISOString() }); // VULNERABLE: the full URL, key included, goes straight into the log.
    if (requestLog.length > 50) requestLog.shift();

    if (key !== DEMO_KEY && key !== INTERNAL_KEY) return reply.code(401).send({ error: "invalid key" });
    if (key === INTERNAL_KEY) {
      await reportSolve(ctx, `GET /api/weather succeeded using the internal-tools key, recovered from /api/request-log rather than ever being issued to the caller`);
    }
    const city = String((req.query as { city?: string }).city ?? "Unknown");
    return { city, tempC: 17, condition: "Overcast", accessLevel: key === INTERNAL_KEY ? "internal" : "demo" };
  });

  app.get("/api/request-log", async () => ({ entries: requestLog.slice(-20) }));

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[weatherapi] fatal error:", err);
  process.exit(1);
});
