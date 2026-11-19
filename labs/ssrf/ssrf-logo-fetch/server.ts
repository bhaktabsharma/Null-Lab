/**
 * InvoiceHub — Fetch My Logo (basic SSRF)
 *
 * POST /logo-preview takes a URL and fetches it SERVER-SIDE with no
 * restriction at all, then reflects the response back to the caller. All
 * "fetching" goes through MockInternalNet, a fully simulated network (see
 * lab-sdk/mock-internal-net.ts) — this lab never opens a real socket,
 * regardless of what URL is supplied. Recorded only when the simulated
 * internal finance service's body actually appears in the response.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, MockInternalNet } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "InvoiceHub";

const net = new MockInternalNet();
const FINANCE_BODY = JSON.stringify({ summary: "Q3 synthetic ledger", pendingWireUsd: 184250, approver: "cfo-demo-account" });
net.registerStatic({ host: "internal-finance.lab", port: 80 }, FINANCE_BODY);
net.registerStatic({ host: "cdn.invoicehub-assets.test", port: 443 }, "fake-image-bytes", { contentType: "image/png" });

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#58b4d9", navLinks: [{ href: "/", label: "Logo settings" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Logo settings",
      `<div class="panel"><h1>Company logo</h1><p class="muted">Paste a URL to your logo image; we'll fetch and preview it.</p>
        <form method="post" action="/logo-preview"><p><input type="text" name="url" placeholder="https://cdn.invoicehub-assets.test/logo.png" style="width:100%;" /></p><button type="submit">Preview</button></form></div>`,
    );
  });

  // --- The vulnerable handler: fetches ANY url, server-side, with no checks. --
  app.post("/logo-preview", async (req, reply) => {
    const url = String((req.body as { url?: unknown } | null)?.url ?? "");
    reply.type("text/html");
    if (!url) {
      reply.code(400);
      return shell("Missing URL", `<div class="panel"><p>Please provide a URL.</p></div>`);
    }

    const res = await net.fetch(url);
    if (!res.ok) {
      return shell("Preview", `<div class="panel"><p>Could not fetch that URL: ${escapeHtml(res.error)}</p></div>`);
    }

    if (res.body === FINANCE_BODY) {
      await reportSolve(ctx, `POST /logo-preview fetched and returned the body of the simulated internal finance service at ${res.resolvedHost}:${res.resolvedPort}`);
    }
    return shell(
      "Preview",
      `<div class="panel"><h1>Preview</h1><p class="muted">Response from ${escapeHtml(res.resolvedHost)} (${res.contentType}, ${res.status}):</p>
        <pre>${escapeHtml(res.body.slice(0, 2000))}</pre></div>`,
    );
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[invoicehub] fatal error:", err);
  process.exit(1);
});
