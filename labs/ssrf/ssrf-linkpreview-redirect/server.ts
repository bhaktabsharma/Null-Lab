/**
 * LinkPreview — Trust, But Verify... Once (SSRF via unchecked redirects)
 *
 * POST /preview validates the SUBMITTED url's host against a real allowlist
 * — that part is correct. But the fetch that follows is done with
 * `fetchFollowingRedirects()`, which transparently follows any redirect the
 * target returns without re-checking the new host against the allowlist.
 * One allowlisted host in this lab is itself a redirector. Recorded only
 * when the content actually shown to the user came from a host that was
 * never checked.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, MockInternalNet } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "LinkPreview";
const ALLOWLIST = new Set(["news.partner.test", "links.partner.test"]);

const net = new MockInternalNet();
net.registerStatic({ host: "news.partner.test", port: 443 }, "<h1>Partner News</h1><p>Synthetic headline of the day.</p>", { contentType: "text/html" });
// "links.partner.test" is allowlisted and legitimate, but its /go endpoint is a generic redirector.
net.registerService({ host: "links.partner.test", port: 443 }, (path) => {
  const match = /[?&]to=([^&]+)/.exec(path);
  if (match) return { redirectTo: decodeURIComponent(match[1]!) };
  return { status: 404, contentType: "text/plain", body: "no target" };
});
net.registerStatic({ host: "internal-cache.lab", port: 80 }, JSON.stringify({ cachedSessions: 318, note: "synthetic internal cache admin view" }));

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#6fa8ff", navLinks: [{ href: "/", label: "Preview" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Link preview",
      `<div class="panel"><h1>Link preview</h1><p class="muted">Allowlisted hosts: ${[...ALLOWLIST].join(", ")}</p>
        <form method="post" action="/preview"><p><input type="text" name="url" style="width:100%;" placeholder="https://news.partner.test/" /></p><button type="submit">Preview</button></form></div>`,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.post("/preview", async (req, reply) => {
    const url = String((req.body as { url?: unknown } | null)?.url ?? "");
    reply.type("text/html");
    let submittedHost: string;
    try {
      submittedHost = new URL(url).hostname;
    } catch {
      reply.code(400);
      return shell("Invalid URL", `<div class="panel"><p>Not a valid URL.</p></div>`);
    }
    if (!ALLOWLIST.has(submittedHost)) {
      reply.code(403);
      return shell("Blocked", `<div class="panel"><p>${escapeHtml(submittedHost)} is not an allowlisted host.</p></div>`);
    }

    // VULNERABLE: redirects from an allowlisted starting point are followed without re-checking.
    const res = await net.fetchFollowingRedirects(url);
    if (!res.ok) {
      return shell("Error", `<div class="panel"><p>${escapeHtml(res.error)}</p></div>`);
    }
    if (!ALLOWLIST.has(res.finalHost)) {
      await reportSolve(ctx, `a request to allowlisted host "${submittedHost}" redirected to "${res.finalHost}", which was never itself checked against the allowlist, and its content was shown to the user`);
    }
    return shell("Preview", `<div class="panel"><h1>Preview</h1><p class="muted">Final source: ${escapeHtml(res.finalHost)} (hops: ${res.hops.join(" → ")})</p><pre>${escapeHtml(res.body)}</pre></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[linkpreview] fatal error:", err);
  process.exit(1);
});
