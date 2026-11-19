/**
 * PulseMonitor — Fire and Forget (blind SSRF)
 *
 * POST /check fetches a user-supplied URL server-side and discards
 * everything about the result — always returning the same "done" response,
 * with no status, no body, no timing signal exposed. This models a genuinely
 * blind SSRF: there's no direct read-back channel at all. The only way to
 * confirm the request landed is an observable SIDE EFFECT on whatever it
 * reached — here, a simulated internal service that increments a counter on
 * every request. /__debug/ping-count exposes that counter (standing in for
 * whatever out-of-band signal a real blind-SSRF exploit would use — a
 * callback server, a DNS log, a timing channel). Recorded only when the
 * counter changes as a result of a /check request.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, MockInternalNet } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "PulseMonitor";

let pingCount = 0;
const net = new MockInternalNet();
net.registerService({ host: "internal-admin.lab", port: 80 }, (path) => {
  if (path.startsWith("/ping-count")) pingCount++;
  return { status: 204, contentType: "text/plain", body: "" };
});
net.registerStatic({ host: "status.partner.test", port: 443 }, "", { status: 204 }); // a plausible "legitimate" external target

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#9d7bd8", navLinks: [{ href: "/", label: "Monitor" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "PulseMonitor",
      `<div class="panel"><h1>PulseMonitor</h1><p class="muted">Enter a URL to check. We'll ping it, but we don't show you the result (this check runs asynchronously on our side).</p>
        <form method="post" action="/check"><p><input type="text" name="url" style="width:100%;" placeholder="https://status.partner.test/" /></p><button type="submit">Check</button></form></div>`,
    );
  });

  // --- The vulnerable handler: truly blind — the outcome is never revealed. ---
  app.post("/check", async (req, reply) => {
    const url = String((req.body as { url?: unknown } | null)?.url ?? "");
    const before = pingCount;
    if (url) await net.fetch(url); // fire-and-forget: result intentionally never inspected or returned
    if (pingCount > before) {
      await reportSolve(ctx, `a /check request caused the simulated internal admin service's ping counter to increment, although /check's own response reveals nothing about the outcome`);
    }
    reply.type("text/html");
    return shell("Submitted", `<div class="panel"><p>Check submitted. Results are not shown here.</p></div>`);
  });

  // Stands in for whatever out-of-band signal a real blind SSRF exploit would use.
  app.get("/__debug/ping-count", async () => ({ pingCount }));

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[pulsemonitor] fatal error:", err);
  process.exit(1);
});
