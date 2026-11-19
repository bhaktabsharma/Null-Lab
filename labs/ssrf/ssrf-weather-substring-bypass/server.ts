/**
 * WeatherWidget — Trusted Partner Only (SSRF via allowlist substring check)
 *
 * The "allowlist" check is `fullUrlString.includes(TRUSTED_HOST)` — tested
 * against the WHOLE url string, not the parsed hostname. A URL whose real
 * host is something else entirely passes as long as the trusted hostname
 * shows up anywhere else in the string (path, query, fragment). Recorded
 * only when the request that gets through actually resolves (by real URL
 * parsing, not string matching) to a host OTHER than the trusted partner,
 * and reaches the simulated internal service.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, MockInternalNet } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "WeatherWidget";
const TRUSTED_HOST = "api.weather-partner.test";

const net = new MockInternalNet();
net.registerStatic({ host: TRUSTED_HOST, port: 443 }, JSON.stringify({ tempC: 18, condition: "Partly cloudy" }));
net.registerStatic({ host: "internal-reports.lab", port: 80 }, JSON.stringify({ report: "synthetic internal sales data", totalUsd: 942000 }));

// VULNERABLE: checks the whole string, not the parsed hostname.
function isAllowedUrl(raw: string): boolean {
  return raw.includes(TRUSTED_HOST);
}

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#7fc7e8", navLinks: [{ href: "/", label: "Widget" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Weather widget",
      `<div class="panel"><h1>Weather widget</h1><p class="muted">Configure a custom weather endpoint (must be on our official partner).</p>
        <form method="post" action="/widget-data"><p><input type="text" name="url" style="width:100%;" value="https://${TRUSTED_HOST}/current" /></p><button type="submit">Fetch</button></form></div>`,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.post("/widget-data", async (req, reply) => {
    const url = String((req.body as { url?: unknown } | null)?.url ?? "");
    reply.type("text/html");
    if (!isAllowedUrl(url)) {
      reply.code(403);
      return shell("Blocked", `<div class="panel"><p>Only our official weather partner is allowed.</p></div>`);
    }

    const res = await net.fetch(url);
    if (!res.ok) {
      return shell("Error", `<div class="panel"><p>Could not fetch: ${escapeHtml(res.error)}</p></div>`);
    }
    if (res.resolvedHost !== TRUSTED_HOST) {
      await reportSolve(ctx, `a request validated by the substring allowlist actually reached "${res.resolvedHost}", not the trusted partner "${TRUSTED_HOST}"`);
    }
    return shell("Widget data", `<div class="panel"><h1>Widget data</h1><p class="muted">From ${escapeHtml(res.resolvedHost)}:</p><pre>${escapeHtml(res.body)}</pre></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[weatherwidget] fatal error:", err);
  process.exit(1);
});
