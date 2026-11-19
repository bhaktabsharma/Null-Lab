/**
 * PaySync — Custom Webhook Destination (SSRF via webhook abuse)
 *
 * Unlike a lab about merely fetching a URL, this one is about a legitimate
 * feature — deliver a payment event to a user-configured webhook URL — being
 * abused by pointing it at an internal service instead of the user's own
 * server. The payload itself carries a synthetic signing secret, as a real
 * payment webhook's payload might; the internal target simply logs what it
 * receives. Recorded only when a delivery carrying that secret reaches the
 * simulated internal secrets-store service rather than a real external
 * destination.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, seededSecret, MockInternalNet } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "PaySync";
const SIGNING_SECRET = `whsec_${seededSecret(ctx, "webhook-signing-secret", 20)}`;

const received: { host: string; body: string }[] = [];
const net = new MockInternalNet();
net.registerService({ host: "internal-secrets.lab", port: 80 }, () => {
  // logging happens in the caller, which has the body; this just has to accept the POST
  return { status: 200, contentType: "application/json", body: '{"stored":true}' };
});
net.registerService({ host: "merchant-endpoint.test", port: 443 }, () => ({ status: 200, contentType: "application/json", body: '{"received":true}' }));

let webhookUrl: string | null = null;

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#4dd0a8", navLinks: [{ href: "/", label: "Webhook settings" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Webhook settings",
      `<div class="panel"><h1>Webhook destination</h1><p class="muted">Current: ${webhookUrl ? escapeHtml(webhookUrl) : "(not configured)"}</p>
        <form method="post" action="/webhooks/configure"><p><input type="text" name="url" style="width:100%;" placeholder="https://merchant-endpoint.test/payhook" /></p><button type="submit">Save</button></form>
        <form method="post" action="/webhooks/trigger-test" style="margin-top:1rem;"><button type="submit">Send test event</button></form></div>`,
    );
  });

  // --- The vulnerable handler: no restriction on the destination host. --------
  app.post("/webhooks/configure", async (req, reply) => {
    const url = String((req.body as { url?: unknown } | null)?.url ?? "");
    reply.type("text/html");
    try {
      new URL(url); // just needs to be a syntactically valid URL — no host restriction at all
    } catch {
      reply.code(400);
      return shell("Invalid URL", `<div class="panel"><p>That doesn't look like a valid URL.</p></div>`);
    }
    webhookUrl = url;
    return reply.redirect("/");
  });

  app.post("/webhooks/trigger-test", async (_req, reply) => {
    reply.type("text/html");
    if (!webhookUrl) {
      reply.code(400);
      return shell("No webhook configured", `<div class="panel"><p>Configure a webhook URL first.</p></div>`);
    }
    const payload = JSON.stringify({ event: "payment.succeeded", amountUsd: 42.5, signingSecret: SIGNING_SECRET });
    const res = await net.fetch(webhookUrl);
    const destHost = new URL(webhookUrl).hostname;
    received.push({ host: destHost, body: payload });

    if (res.ok && destHost === "internal-secrets.lab") {
      await reportSolve(ctx, `a webhook delivery carrying the signing secret was sent to the simulated internal secrets-store service at ${destHost}, not an external destination`);
    }
    return shell(
      "Test sent",
      `<div class="panel"><p>Test event sent to ${escapeHtml(destHost)}.</p>${res.ok ? "" : `<p class="muted">Delivery failed: ${escapeHtml(res.error)}</p>`}</div>`,
    );
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[paysync] fatal error:", err);
  process.exit(1);
});
