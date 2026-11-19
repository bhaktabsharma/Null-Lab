/**
 * CloudOps Dashboard — Instance Info Widget (SSRF to cloud metadata)
 *
 * The widget fetches whatever URL is configured, server-side, with no
 * restriction — the same basic SSRF pattern as other labs in this family,
 * but aimed specifically at the address every major cloud platform's
 * instance-metadata service conventionally listens on:
 * 169.254.169.254 (link-local, meant to be reachable only from the
 * instance itself). All "fetching" goes through MockInternalNet, a fully
 * simulated network — this lab never opens a real socket, and 169.254.169.254
 * here resolves to nothing but an in-memory fixture. Recorded only when the
 * widget's rendered content actually contains the simulated credentials.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, MockInternalNet } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "CloudOps Dashboard";
const METADATA_BODY = JSON.stringify({
  role: "cloudops-deploy-role",
  accessKeyId: "AKIA-SYNTHETIC-DEMO",
  secretAccessKey: "synthetic/demo/secret+key/NeverReal",
  expiration: "2099-01-01T00:00:00Z",
});

const net = new MockInternalNet();
net.registerStatic({ host: "169.254.169.254", port: 80 }, METADATA_BODY);
net.registerStatic({ host: "status.partner.test", port: 443 }, JSON.stringify({ status: "operational" }));

let widgetUrl = "https://status.partner.test/";

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#64b5e0", navLinks: [{ href: "/dashboard", label: "Dashboard" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/dashboard", async (_req, reply) => {
    const res = await net.fetch(widgetUrl);
    reply.type("text/html");
    const widgetContent = res.ok ? res.body : `Could not fetch: ${res.error}`;
    if (res.ok && res.body === METADATA_BODY) {
      await reportSolve(ctx, `the status widget, configured to fetch "${widgetUrl}", displayed the simulated cloud instance-role credentials`);
    }
    return shell(
      "Dashboard",
      `<div class="panel"><h1>CloudOps Dashboard</h1>
        <div class="panel" style="background:#0b0e13;"><h2>Status widget</h2><p class="muted">Source: ${escapeHtml(widgetUrl)}</p><pre>${escapeHtml(widgetContent)}</pre></div>
        <form method="post" action="/widget/configure" style="margin-top:1rem;"><p><input type="text" name="url" style="width:100%;" value="${escapeHtml(widgetUrl)}" /></p><button type="submit">Update widget source</button></form></div>`,
    );
  });

  app.post("/widget/configure", async (req, reply) => {
    const url = String((req.body as { url?: unknown } | null)?.url ?? "");
    if (url) widgetUrl = url;
    return reply.redirect("/dashboard");
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[cloudops-dashboard] fatal error:", err);
  process.exit(1);
});
