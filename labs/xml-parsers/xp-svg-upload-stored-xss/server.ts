/**
 * GalleryUp — Vector Art Welcome (stored XSS via SVG upload)
 *
 * SVG is an XML document format and can legally contain a <script>
 * element. The upload accepts it unmodified (no sanitization of the SVG's
 * own markup), and the gallery page INLINES each stored piece's raw markup
 * directly into its own HTML (string concatenation, unsanitized) so it
 * renders inside the page's own document — a common real pattern for an
 * inline "preview" or "featured image." (Referencing it instead via
 * <object>/<iframe> would still run the script, but inside an isolated
 * nested document with no access to the gallery page's own DOM — inlining
 * is what makes this genuinely a same-document stored XSS.) Recorded only
 * when a script inside an uploaded SVG actually runs in an admin session
 * and exfiltrates the admin-only token.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, registerAdminSession, adminSecretFor } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "GalleryUp";
const ADMIN_COOKIE = "gu_admin";
const TOKEN = adminSecretFor(ctx, "gallery-token");

interface Piece { id: number; filename: string; svg: string; }
const gallery: Piece[] = [];
let nextId = 1;

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#ff9ec4", navLinks: [{ href: "/gallery", label: "Gallery" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  registerAdminSession(app, ctx, ADMIN_COOKIE);

  app.get("/", async (_req, reply) => reply.redirect("/gallery"));

  app.get("/gallery", async (req, reply) => {
    const isAdmin = req.headers.cookie?.includes(`${ADMIN_COOKIE}=`) ?? false;
    reply.type("text/html");
    return shell(
      "Gallery",
      `<div class="panel" ${isAdmin ? `data-token="${TOKEN}"` : ""} id="gallery-root"><h1>Vector art gallery</h1>
        <form method="post" action="/gallery/upload"><p><input type="text" name="filename" placeholder="my-art.svg" /></p>
        <p><textarea name="svg" rows="4" style="width:100%;" placeholder="&lt;svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'&gt;&lt;circle cx='50' cy='50' r='40' /&gt;&lt;/svg&gt;"></textarea></p>
        <button type="submit">Upload</button></form>
        <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:1rem;">
        ${gallery.map((p) => `<div style="width:120px;height:120px;background:#0b0e13;border-radius:8px;overflow:hidden;">${p.svg}</div>`).join("")}
        </div></div>`,
    );
  });

  app.post("/gallery/upload", async (req, reply) => {
    // VULNERABLE: the SVG's own markup is stored completely unmodified.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const filename = typeof body.filename === "string" ? body.filename.slice(0, 100) : "untitled.svg";
    const svg = typeof body.svg === "string" ? body.svg.slice(0, 4000) : "";
    reply.type("text/html");
    if (!svg.includes("<svg")) {
      reply.code(400);
      return shell("Invalid", `<div class="panel"><p>That doesn't look like an SVG.</p></div>`);
    }
    gallery.push({ id: nextId++, filename, svg });
    return reply.redirect("/gallery");
  });

  app.get("/gallery/raw/:id", async (req, reply) => {
    const piece = gallery.find((p) => p.id === Number((req.params as { id: string }).id));
    if (!piece) return reply.code(404).send("not found");
    reply.header("content-type", "image/svg+xml");
    return piece.svg;
  });

  app.get("/collect", async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    if (token && token === TOKEN) {
      await reportSolve(ctx, `script inside an uploaded SVG, rendered via <object> on the gallery page, exfiltrated the admin-only token`);
    }
    reply.header("content-type", "image/gif");
    return Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[galleryup] fatal error:", err);
  process.exit(1);
});
