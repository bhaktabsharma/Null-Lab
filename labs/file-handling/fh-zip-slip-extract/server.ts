/**
 * ThemeHub — Install a Theme (zip slip / unsafe archive extraction)
 *
 * POST /themes/install takes a list of archive entries (a SIMULATED
 * in-memory stand-in for a real .zip's entry list — see mini-vfs.ts's
 * ArchiveEntry; no real archive file or real filesystem is ever involved)
 * and extracts each one by joining its OWN path directly onto the themes
 * directory, with no check that the result stays inside it. Recorded only
 * when extraction actually writes a file outside the themes directory that
 * did not already exist there.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, MiniVfs, type ArchiveEntry } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "ThemeHub";
const THEMES_DIR = "/app/themes";
const STARTUP_SCRIPT = "/app/app/startup.sh";

const vfs = new MiniVfs({
  [STARTUP_SCRIPT]: "#!/bin/sh\necho 'synthetic startup script — unmodified'\n",
});
const beforePaths = new Set(vfs.allPaths());

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#9b6bd8", navLinks: [{ href: "/", label: "Themes" }] });
}

const INSTALL_SCRIPT = `
document.getElementById("install-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  const entries = JSON.parse(document.getElementById("entries").value);
  const res = await fetch("/themes/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries }) });
  document.getElementById("out").textContent = JSON.stringify(await res.json(), null, 2);
});
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    const sample = JSON.stringify([{ path: "ocean-blue/theme.css", content: "body { background: #1a2b4a; }" }, { path: "ocean-blue/preview.txt", content: "Ocean Blue theme" }], null, 2);
    reply.type("text/html");
    return shell(
      "Install a theme",
      `<div class="panel"><h1>Install a theme</h1><p class="muted">Paste a theme package's entry list (JSON array of {path, content}) and install it.</p>
        <form id="install-form"><p><textarea id="entries" rows="8" style="width:100%;">${escapeHtml(sample)}</textarea></p><button type="submit">Install</button></form>
        <pre id="out"></pre></div>
       <script>${INSTALL_SCRIPT}</script>`,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.post("/themes/install", async (req, reply) => {
    const body = (req.body ?? {}) as { entries?: unknown };
    if (!Array.isArray(body.entries) || body.entries.length === 0 || body.entries.length > 20) {
      return reply.code(400).send({ error: "entries must be a non-empty array of at most 20 items" });
    }
    const entries = body.entries as ArchiveEntry[];
    const written: string[] = [];
    for (const entry of entries) {
      if (typeof entry.path !== "string" || typeof entry.content !== "string" || entry.content.length > 2000) {
        return reply.code(400).send({ error: "each entry needs a string path and content" });
      }
      // VULNERABLE: each entry's own path is joined with no containment check.
      const dest = `${THEMES_DIR}/${entry.path}`;
      vfs.write(dest, { content: entry.content });
      written.push(vfs.normalize(dest));
    }

    const escaped = written.filter((p) => !vfs.isUnder(THEMES_DIR, p));
    const newOutsidePaths = escaped.filter((p) => !beforePaths.has(p) || vfs.read(p)?.content !== undefined);
    if (escaped.length > 0 && escaped.includes(STARTUP_SCRIPT)) {
      await reportSolve(ctx, `theme install wrote to "${STARTUP_SCRIPT}" (outside ${THEMES_DIR}) via an archive entry path containing traversal sequences`);
    }
    return { installed: written.length, paths: written, warning: escaped.length > 0 ? `${escaped.length} entr${escaped.length > 1 ? "ies" : "y"} wrote outside the themes directory` : undefined, outsideAttempted: newOutsidePaths };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[themehub] fatal error:", err);
  process.exit(1);
});
