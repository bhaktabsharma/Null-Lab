/**
 * MetricsPing — Blocked, Technically (SSRF via IP-encoding blocklist bypass)
 *
 * The blocklist compares the RAW user string against a short, exact list of
 * loopback spellings ("localhost", "127.0.0.1", and a couple of obvious
 * variants) — before any URL parsing happens. A standards-compliant URL
 * parser, however, accepts several other numeric encodings of the exact
 * same address (decimal, hex, octal, short forms), which the blocklist
 * never anticipated because it never normalizes anything. Recorded only
 * when a request whose ORIGINAL string matched none of the blocklist
 * entries still resolves (via real URL parsing) to a loopback address and
 * reaches the simulated service there.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, MockInternalNet } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "MetricsPing";
const BLOCKLIST = ["localhost", "127.0.0.1", "0.0.0.0", "::1"];

const net = new MockInternalNet();
net.registerStatic({ host: "127.0.0.1", port: 9100 }, JSON.stringify({ uptimeSeconds: 884210, activeConnections: 14, buildTag: "synthetic-metrics-v1" }));

// VULNERABLE: compares the raw string, before any parsing/normalization.
function isBlocked(raw: string): boolean {
  const lower = raw.toLowerCase();
  return BLOCKLIST.some((bad) => lower.includes(bad));
}

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#e08a4d", navLinks: [{ href: "/", label: "Ping tool" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Ping tool",
      `<div class="panel"><h1>MetricsPing</h1><p class="muted">Check whether an external metrics endpoint is reachable. Loopback addresses are blocked.</p>
        <form method="post" action="/ping"><p><input type="text" name="url" style="width:100%;" placeholder="http://metrics.partner.test:9100/" /></p><button type="submit">Ping</button></form></div>`,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.post("/ping", async (req, reply) => {
    const rawUrl = String((req.body as { url?: unknown } | null)?.url ?? "");
    reply.type("text/html");
    if (isBlocked(rawUrl)) {
      reply.code(403);
      return shell("Blocked", `<div class="panel"><p>Loopback addresses are not allowed.</p></div>`);
    }

    const res = await net.fetch(rawUrl);
    if (!res.ok) {
      return shell("Unreachable", `<div class="panel"><p>${escapeHtml(res.error)}</p></div>`);
    }
    if (res.resolvedHost === "127.0.0.1" || res.resolvedHost === "::1") {
      await reportSolve(ctx, `request to raw string "${rawUrl}" (which matched none of the blocklist's entries) actually resolved to loopback host "${res.resolvedHost}"`);
    }
    return shell("Ping result", `<div class="panel"><h1>Ping result</h1><p class="muted">Reached ${escapeHtml(res.resolvedHost)}:</p><pre>${escapeHtml(res.body)}</pre></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[metricsping] fatal error:", err);
  process.exit(1);
});
