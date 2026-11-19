/**
 * AvatarHub — Images Only (upload extension-validation bypass)
 *
 * POST /avatar/upload checks whether an allowed image extension appears
 * ANYWHERE in the filename (`.includes(ext)`), then stores the file under
 * its ORIGINAL filename — so "payload.php.png" passes the check (it
 * contains ".png") while "shell.png.php" ALSO passes it (it contains
 * ".png" too) and is stored with a ".php" suffix, its real, effective
 * extension. Simulated uploads directory only (mini-vfs.ts). Recorded only
 * when a file is actually stored whose real final extension is not an
 * allowed image type.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, MiniVfs } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "AvatarHub";
const UPLOADS_DIR = "/app/uploads/avatars";
const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif"];

const vfs = new MiniVfs();

function realExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

// VULNERABLE: substring presence anywhere in the name, not the actual final extension.
function looksLikeImage(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.includes(ext));
}

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#d87fa0", navLinks: [{ href: "/", label: "Avatar" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Avatar upload",
      `<div class="panel"><h1>Avatar upload</h1><p class="muted">Images only (.png, .jpg, .jpeg, .gif).</p>
        <form method="post" action="/avatar/upload"><p><input type="text" name="filename" placeholder="my-avatar.png" /></p>
        <p><textarea name="content" rows="3" style="width:100%;" placeholder="File content"></textarea></p><button type="submit">Upload</button></form>
        <h2>Stored files</h2><ul id="list">${vfs.list(UPLOADS_DIR).map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul></div>`,
    );
  });

  // --- The vulnerable handler --------------------------------------------------
  app.post("/avatar/upload", async (req, reply) => {
    const b = (req.body ?? {}) as { filename?: unknown; content?: unknown };
    const filename = typeof b.filename === "string" ? b.filename : "";
    const content = typeof b.content === "string" ? b.content : "";
    reply.type("text/html");
    if (!filename || filename.length > 100 || content.length > 2000 || filename.includes("/") || filename.includes("..")) {
      reply.code(400);
      return shell("Invalid", `<div class="panel"><p>Invalid filename.</p></div>`);
    }
    if (!looksLikeImage(filename)) {
      reply.code(415);
      return shell("Rejected", `<div class="panel"><p>Only image files are allowed.</p></div>`);
    }

    vfs.write(`${UPLOADS_DIR}/${filename}`, { content });
    const ext = realExtension(filename);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      await reportSolve(ctx, `a file named "${filename}" (real extension "${ext || "(none)"}") was accepted and stored, although that is not an allowed image extension`);
    }
    return shell("Uploaded", `<div class="panel"><p>Stored as ${escapeHtml(filename)}.</p><p><a class="link" href="/">Back</a></p></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[avatarhub] fatal error:", err);
  process.exit(1);
});
