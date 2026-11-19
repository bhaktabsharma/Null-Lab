/**
 * SiteForge — Someone Forgot to Clean Up (backup file exposure)
 *
 * /static/<name> serves whatever is present in a simulated static directory
 * verbatim — including a leftover editor/deploy backup file sitting right
 * alongside the real, rendered page, which a deploy script should have
 * excluded but didn't. Simulated filesystem only (mini-vfs.ts). Recorded
 * only when a request for that backup-style name actually returns raw
 * source rather than the normal rendered page.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, MiniVfs } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "SiteForge";
const STATIC_DIR = "/app/static";

const RAW_SOURCE = `<?php
// index.php — left in the build by mistake
$db = new PDO('mysql:host=internal-db.lab;dbname=siteforge', 'app_user', 'Zx4#mPk9Qw');
require_once 'config/secrets.php';
echo render_homepage();
`;

const vfs = new MiniVfs({
  "/app/static/index.html": "<h1>Welcome to SiteForge</h1><p>A simple site builder.</p>",
  "/app/static/about.html": "<h1>About</h1><p>SiteForge is a demo.</p>",
  "/app/static/index.php.bak": RAW_SOURCE, // the leftover
});

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#6bb3d8", navLinks: [{ href: "/", label: "Home" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "SiteForge",
      `<div class="panel"><h1>SiteForge</h1><p class="muted">Served pages: <a class="link" href="/static/index.html">index.html</a>, <a class="link" href="/static/about.html">about.html</a></p></div>`,
    );
  });

  // --- The vulnerable handler: serves the whole directory, including the backup. --
  app.get("/static/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const entry = vfs.read(`${STATIC_DIR}/${name}`);
    if (!entry) {
      reply.code(404);
      reply.type("text/plain");
      return "Not found.";
    }
    if (entry.content === RAW_SOURCE) {
      await reportSolve(ctx, `GET /static/${name} served the raw, unrendered source of a leftover backup file instead of the rendered site`);
    }
    reply.type(entry.content === RAW_SOURCE ? "text/plain" : "text/html");
    return entry.content;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[siteforge] fatal error:", err);
  process.exit(1);
});
