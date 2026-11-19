/**
 * SupportDesk — Stored XSS in Community Thread
 *
 * Anyone can post to a public community help thread (no login required —
 * realistic for a public forum/help board). Comments are rendered
 * verbatim, with no encoding. A stored payload only matters once a
 * privileged session later views it — so, as with the reflected-XSS lab,
 * the admin-only secret element is rendered BEFORE the stored comments in
 * HTML source order, so a payload that runs synchronously during parsing
 * can actually find it in the DOM.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  parseCookies,
  verifySession,
  adminSecretFor,
  registerAdminSession,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const ADMIN_COOKIE = "supportdesk_stored_admin";
const SECRET = adminSecretFor(ctx, "stored-ticket");

interface Comment {
  name: string;
  message: string;
}

const COMMENTS: Comment[] = [
  { name: "priya", message: "Anyone else seeing the export button spinner forever?" },
  { name: "support-agent", message: "Known issue, a fix is rolling out this week — thanks for flagging it!" },
];

function isAdmin(cookieHeader: string | undefined): boolean {
  const session = verifySession<{ role: string }>(ctx.instanceToken, parseCookies(cookieHeader)[ADMIN_COOKIE]);
  return session?.role === "admin";
}

function shell(title: string, body: string) {
  return renderShell(title, body, { appName: "SupportDesk", accent: "#e0a63f", navLinks: [{ href: "/thread", label: "Community Thread" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: "SupportDesk" });
  registerAdminSession(app, ctx, ADMIN_COOKIE);

  app.get("/", async (_req, reply) => reply.redirect("/thread"));

  // --- The vulnerable render — the stored XSS surface -------------------------
  app.get("/thread", async (req, reply) => {
    const admin = isAdmin(req.headers.cookie);
    reply.type("text/html");
    return shell(
      "Community Help Thread",
      `<div class="panel">
        <h1>Community Help Thread</h1>
        <p class="muted">Public thread — anyone can post. Be nice.</p>
        ${admin ? `<span id="admin-token" data-token="${SECRET}" style="display:none"></span>` : ""}
        ${COMMENTS.map(
          (c) =>
            // VULNERABLE: comment name/message rendered with no encoding.
            `<div class="panel" style="background:#0b0e13;margin-bottom:0.6rem;">
              <strong>${c.name}</strong>
              <p style="margin:0.3rem 0 0;">${c.message}</p>
            </div>`,
        ).join("")}
        <form method="post" action="/thread/comments" style="margin-top:1.5rem;">
          <p><input type="text" name="name" placeholder="Your name" /></p>
          <p><textarea name="message" rows="3" placeholder="Write a comment..."></textarea></p>
          <button type="submit">Post comment</button>
        </form>
      </div>`,
    );
  });

  app.post("/thread/comments", async (req, reply) => {
    const body = req.body as { name?: string; message?: string };
    const name = (body.name ?? "anonymous").slice(0, 60) || "anonymous";
    const message = (body.message ?? "").slice(0, 1000);
    if (message.trim()) COMMENTS.push({ name, message });
    return reply.redirect("/thread");
  });

  app.get("/collect", async (req, reply) => {
    const token = String((req.query as { token?: string }).token ?? "");
    if (token === SECRET) {
      await reportSolve(
        ctx,
        "a script running in the admin session exfiltrated the admin token to GET /collect, proving stored XSS via a posted community-thread comment",
      );
    }
    reply.header("content-type", "image/gif");
    return reply.send(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7", "base64"));
  });

  await startLabApp(app, ctx, "SupportDesk");
}

main().catch((err) => {
  console.error("[supportdesk-xss-stored] fatal error:", err);
  process.exit(1);
});
