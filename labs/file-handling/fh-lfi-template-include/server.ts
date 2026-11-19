/**
 * HelpCenter — Pick a Page (local file inclusion)
 *
 * GET /help?page= resolves a template path by joining the page name onto
 * the templates directory and renders whatever content it finds INLINE, as
 * if it were always a help article — with no check that the resolved path
 * actually stays inside the templates directory. Simulated filesystem only
 * (mini-vfs.ts). Recorded only when the rendered content comes from a file
 * outside the templates directory.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, MiniVfs } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "HelpCenter";
const TEMPLATES_DIR = "/app/templates";

const vfs = new MiniVfs({
  "/app/templates/getting-started.txt": "Getting started: create an account, then add your first project.",
  "/app/templates/billing-faq.txt": "Billing FAQ: invoices are issued monthly on the 1st.",
  "/app/config/app-config.txt": "SMTP_HOST=internal-mail.lab\nSMTP_PASSWORD=Qw8!vNx2Rk\nSESSION_SIGNING_KEY=dev-signing-key-942",
});

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#64c2b0", navLinks: [{ href: "/", label: "Help" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    const pages = vfs.list(TEMPLATES_DIR);
    reply.type("text/html");
    return shell(
      "Help center",
      `<div class="panel"><h1>Help center</h1><ul>${pages.map((p) => `<li><a class="link" href="/help?page=${encodeURIComponent(p)}">${escapeHtml(p)}</a></li>`).join("")}</ul></div>`,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.get("/help", async (req, reply) => {
    const page = String((req.query as { page?: string }).page ?? "getting-started.txt");
    reply.type("text/html");
    // VULNERABLE: no containment check on the resolved path.
    const path = `${TEMPLATES_DIR}/${page}`;
    const entry = vfs.read(path);
    if (!entry) {
      reply.code(404);
      return shell("Not found", `<div class="panel"><p>No such help page.</p></div>`);
    }
    const resolved = vfs.normalize(path);
    if (!vfs.isUnder(TEMPLATES_DIR, resolved)) {
      await reportSolve(ctx, `GET /help?page=${page} rendered the content of "${resolved}", outside the templates directory`);
    }
    return shell("Help", `<div class="panel"><h1>Help</h1><pre>${escapeHtml(entry.content)}</pre></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[helpcenter] fatal error:", err);
  process.exit(1);
});
