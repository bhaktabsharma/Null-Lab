/**
 * InvoicePrint — HTML to PDF (second-order SSRF via document rendering)
 *
 * POST /invoices/render-pdf takes submitted HTML and, to "embed" every
 * referenced image, fetches EACH <img src="..."> found in it — a resource-
 * fetching step nested inside what looks like an unrelated document-
 * formatting feature (exactly the shape of several real "HTML/URL to PDF"
 * SSRF reports). All fetching goes through MockInternalNet, a fully
 * simulated network (see mini-vfs.ts's sibling, mock-internal-net.ts) — no
 * real socket is ever opened. The "PDF" returned here is a simplified
 * plain-text summary for the lab, listing each embedded resource's content.
 * Recorded only when that output actually contains the simulated internal
 * service's body.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, MockInternalNet } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "InvoicePrint";

const net = new MockInternalNet();
net.registerStatic({ host: "cdn.invoiceassets.test", port: 443 }, "fake-logo-image-bytes", { contentType: "image/png" });
net.registerStatic({ host: "internal-billing.lab", port: 80 }, JSON.stringify({ stripeLikeKey: "sk_live_synthetic_demo_0000", note: "internal billing config — never public" }));

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#d8a85c", navLinks: [{ href: "/", label: "Render invoice" }] });
}

function extractImageUrls(html: string): string[] {
  const urls: string[] = [];
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && urls.length < 10) urls.push(m[1]!);
  return urls;
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    const sample = `<h1>Invoice #4471</h1><img src="https://cdn.invoiceassets.test/logo.png" /><p>Total: $120.00</p>`;
    reply.type("text/html");
    return shell(
      "Render invoice",
      `<div class="panel"><h1>Render invoice as PDF</h1>
        <form method="post" action="/invoices/render-pdf"><p><textarea name="html" rows="6" style="width:100%;">${escapeHtml(sample)}</textarea></p><button type="submit">Render</button></form></div>`,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.post("/invoices/render-pdf", async (req, reply) => {
    const html = String((req.body as { html?: unknown } | null)?.html ?? "");
    reply.type("text/html");
    if (!html || html.length > 4000) {
      reply.code(400);
      return shell("Invalid", `<div class="panel"><p>Provide some invoice HTML (max 4000 characters).</p></div>`);
    }

    const imageUrls = extractImageUrls(html);
    const embedded: string[] = [];
    for (const url of imageUrls) {
      const res = await net.fetch(url); // VULNERABLE: every referenced image URL is fetched, unrestricted.
      embedded.push(res.ok ? `[embedded resource from ${res.resolvedHost}]: ${res.body}` : `[could not embed ${url}: ${res.error}]`);
    }

    const pdfText = [`=== InvoicePrint rendered document ===`, html.replace(/<[^>]+>/g, " ").trim(), ...embedded].join("\n\n");
    if (pdfText.includes("stripeLikeKey")) {
      await reportSolve(ctx, `rendering a submitted invoice fetched an <img> URL pointing at the internal billing service, embedding its body in the generated PDF`);
    }
    return shell("Rendered", `<div class="panel"><h1>Rendered PDF (text summary)</h1><pre>${escapeHtml(pdfText)}</pre></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[invoiceprint] fatal error:", err);
  process.exit(1);
});
