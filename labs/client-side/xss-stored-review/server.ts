/**
 * ShopMart — Stored XSS in Product Reviews
 *
 * Same stored-XSS shape as the SupportDesk community thread lab, but a
 * different app, object model and business context (a product review
 * feed a store admin moderates), per the spec's requirement that distinct
 * lab scenarios differ in more than name/id.
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
const ADMIN_COOKIE = "shopmart_review_admin";
const SECRET = adminSecretFor(ctx, "stored-review");

interface Review {
  reviewer: string;
  comment: string;
  stars: number;
}

const PRODUCT = { id: 1, name: "Mechanical Keyboard (TKL, brown switches)", price: "$129.99" };
const REVIEWS: Review[] = [
  { reviewer: "bob", comment: "Solid switches, a little loud for an open office.", stars: 4 },
  { reviewer: "priya", comment: "Great value, been using it daily for months.", stars: 5 },
];

function isAdmin(cookieHeader: string | undefined): boolean {
  const session = verifySession<{ role: string }>(ctx.instanceToken, parseCookies(cookieHeader)[ADMIN_COOKIE]);
  return session?.role === "admin";
}

function shell(title: string, body: string) {
  return renderShell(title, body, { appName: "ShopMart", accent: "#3fb8af", navLinks: [{ href: `/products/${PRODUCT.id}`, label: "Product" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: "ShopMart" });
  registerAdminSession(app, ctx, ADMIN_COOKIE);

  app.get("/", async (_req, reply) => reply.redirect(`/products/${PRODUCT.id}`));

  // --- The vulnerable render — the stored XSS surface -------------------------
  app.get("/products/:id", async (req, reply) => {
    const admin = isAdmin(req.headers.cookie);
    reply.type("text/html");
    return shell(
      PRODUCT.name,
      `<div class="panel">
        <h1>${PRODUCT.name}</h1>
        <p class="muted">${PRODUCT.price}</p>
      </div>
      <div class="panel">
        <h1>Reviews</h1>
        ${admin ? `<span id="admin-token" data-token="${SECRET}" style="display:none"></span>` : ""}
        ${REVIEWS.map(
          (r) =>
            // VULNERABLE: review comment rendered with no encoding.
            `<div class="panel" style="background:#0b0e13;margin-bottom:0.6rem;">
              <strong>${r.reviewer}</strong> <span class="pill">${"★".repeat(r.stars)}</span>
              <p style="margin:0.3rem 0 0;">${r.comment}</p>
            </div>`,
        ).join("")}
        <form method="post" action="/products/${PRODUCT.id}/reviews" style="margin-top:1.5rem;">
          <p><input type="text" name="reviewer" placeholder="Your name" /></p>
          <p><textarea name="comment" rows="3" placeholder="Write a review..."></textarea></p>
          <button type="submit">Post review</button>
        </form>
      </div>`,
    );
  });

  app.post("/products/:id/reviews", async (req, reply) => {
    const body = req.body as { reviewer?: string; comment?: string };
    const reviewer = (body.reviewer ?? "anonymous").slice(0, 60) || "anonymous";
    const comment = (body.comment ?? "").slice(0, 1000);
    if (comment.trim()) REVIEWS.push({ reviewer, comment, stars: 5 });
    return reply.redirect(`/products/${PRODUCT.id}`);
  });

  app.get("/collect", async (req, reply) => {
    const token = String((req.query as { token?: string }).token ?? "");
    if (token === SECRET) {
      await reportSolve(
        ctx,
        "a script running in the admin moderation session exfiltrated the admin token to GET /collect, proving stored XSS via a posted product review",
      );
    }
    reply.header("content-type", "image/gif");
    return reply.send(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7", "base64"));
  });

  await startLabApp(app, ctx, "ShopMart");
}

main().catch((err) => {
  console.error("[shopmart-xss-stored] fatal error:", err);
  process.exit(1);
});
