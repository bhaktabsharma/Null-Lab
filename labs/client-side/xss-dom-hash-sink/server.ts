/**
 * QuickFilter — The URL Never Leaves the Browser (DOM-based XSS)
 *
 * /dashboard ships inline JS that reads `location.hash` on load and writes
 * it into the page via `innerHTML`. The server never sees the fragment at
 * all (browsers don't send it), so there's no server-side "input" to sanitize
 * — the whole vulnerability lives in the client script. The admin-only token
 * is rendered only when the request carries the admin cookie. Recorded only
 * when /collect receives that exact token, proving script ran in that session.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, registerAdminSession, adminSecretFor } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "QuickFilter";
const ADMIN_COOKIE = "qf_admin";
const TOKEN = adminSecretFor(ctx, "dashboard-token");

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#64d8ff", navLinks: [{ href: "/dashboard", label: "Dashboard" }] });
}

const DASHBOARD_SCRIPT = `
(function () {
  var box = document.getElementById("active-filter");
  var raw = location.hash.replace(/^#/, "");
  var m = /filter=(.*)$/.exec(raw);
  if (m) {
    // VULNERABLE: fragment value written into the DOM with innerHTML, no encoding.
    box.innerHTML = "Showing results for: " + decodeURIComponent(m[1]);
  } else {
    box.textContent = "No filter applied.";
  }
})();
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  registerAdminSession(app, ctx, ADMIN_COOKIE);

  app.get("/", async (_req, reply) => reply.redirect("/dashboard"));

  app.get("/dashboard", async (req, reply) => {
    const isAdmin = req.headers.cookie?.includes(`${ADMIN_COOKIE}=`) ?? false;
    reply.type("text/html");
    return shell(
      "Dashboard",
      `<div class="panel" ${isAdmin ? `data-token="${TOKEN}"` : ""} id="dash">
        <h1>Dashboard</h1>
        <p class="muted">Try <code>#filter=invoices</code> in the address bar — the active filter below updates instantly, with no page reload.</p>
        <p id="active-filter" class="pill">No filter applied.</p>
      </div>
      <script>${DASHBOARD_SCRIPT}</script>`,
    );
  });

  app.get("/collect", async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    if (token && token === TOKEN) {
      await reportSolve(ctx, `/collect received the admin dashboard token, exfiltrated by a script that ran via a DOM sink reading location.hash`);
    }
    reply.header("content-type", "image/gif");
    return Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[quickfilter] fatal error:", err);
  process.exit(1);
});
