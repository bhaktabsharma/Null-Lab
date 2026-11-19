/**
 * ShopMart — Order Address Tamper (write-based IDOR)
 *
 * Unlike the invoice-leak lab (a read-based IDOR), this one models a
 * write-based object-property-level authorization failure: POST
 * /orders/:id/address updates an order's shipping address without
 * checking the order belongs to the signed-in customer. The solve is
 * reported only at the moment that write actually succeeds against an
 * order owned by someone else — never just for *viewing* a foreign order.
 */
import {
  createLabApp,
  startLabApp,
  loadLabContext,
  reportSolve,
  renderShell,
  escapeHtml,
  signSession,
  verifySession,
  parseCookies,
} from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const SESSION_COOKIE = "shopmart_session";

interface User {
  username: string;
  password: string;
  displayName: string;
}
interface Order {
  id: number;
  owner: string;
  status: string;
  items: string;
  address: string;
}

const USERS: User[] = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "bob", password: "hunter22", displayName: "Bob Okafor" },
];

const ORDERS: Order[] = [
  { id: 501, owner: "alice", status: "Processing", items: "Mechanical Keyboard (TKL)", address: "12 Birch Lane, Springvale" },
  { id: 502, owner: "bob", status: "Processing", items: "Ergonomic Office Chair", address: "88 Elm Street, Riverton" },
  { id: 503, owner: "bob", status: "Shipped", items: "27in 4K Monitor", address: "88 Elm Street, Riverton" },
];

function getSession(cookieHeader: string | undefined): { user: string } | null {
  return verifySession<{ user: string }>(ctx.instanceToken, parseCookies(cookieHeader)[SESSION_COOKIE]);
}

function shell(title: string, body: string, user?: string) {
  return renderShell(title, body, {
    appName: "ShopMart",
    accent: "#3fb8af",
    currentUserLabel: user ?? null,
    navLinks: user
      ? [
          { href: "/dashboard", label: "Dashboard" },
          { href: "/orders", label: "My Orders" },
          { href: "/logout", label: "Log out" },
        ]
      : [{ href: "/login", label: "Log in" }],
  });
}

async function main() {
  const app = await createLabApp(ctx, { appName: "ShopMart" });

  app.get("/", async (req, reply) => reply.redirect(getSession(req.headers.cookie) ? "/dashboard" : "/login"));

  app.get("/login", async (req, reply) => {
    const err = (req.query as any)?.error;
    reply.type("text/html");
    return shell(
      "Sign in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;">
        <h1>Sign in to ShopMart</h1>
        ${err ? `<p class="muted" style="color:#e07a7a;">Incorrect username or password.</p>` : ""}
        <form method="post" action="/login">
          <p><input type="text" name="username" placeholder="Username" /></p>
          <p><input type="password" name="password" placeholder="Password" /></p>
          <button type="submit">Sign in</button>
        </form>
        <p class="muted" style="margin-top:1rem;">Demo account: <strong>alice</strong> / practice123</p>
      </div>`,
    );
  });

  app.post("/login", async (req, reply) => {
    const body = req.body as { username?: string; password?: string };
    const user = USERS.find((u) => u.username === body.username && u.password === body.password);
    if (!user) return reply.redirect("/login?error=1");
    reply.setCookie(SESSION_COOKIE, signSession(ctx.instanceToken, { user: user.username }), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    return reply.redirect("/dashboard");
  });

  app.get("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.redirect("/login");
  });

  app.get("/dashboard", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    if (!session) return reply.redirect("/login");
    const user = USERS.find((u) => u.username === session.user)!;
    reply.type("text/html");
    return shell(
      "Dashboard",
      `<div class="panel">
        <h1>Welcome back, ${escapeHtml(user.displayName)}</h1>
        <p class="muted">Track and manage your recent orders here.</p>
        <p><a class="btn" href="/orders">View my orders</a></p>
      </div>`,
      user.displayName,
    );
  });

  app.get("/orders", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    if (!session) return reply.redirect("/login");
    const mine = ORDERS.filter((o) => o.owner === session.user);
    reply.type("text/html");
    return shell(
      "My Orders",
      `<div class="panel">
        <h1>My Orders</h1>
        <table>
          <tr><th>Order #</th><th>Status</th><th>Items</th><th>Shipping Address</th><th></th></tr>
          ${mine
            .map(
              (o) => `<tr>
                <td>#${o.id}</td><td><span class="pill">${escapeHtml(o.status)}</span></td>
                <td>${escapeHtml(o.items)}</td><td>${escapeHtml(o.address)}</td>
                <td><a class="link" href="/orders/${o.id}/edit">Edit address</a></td>
              </tr>`,
            )
            .join("")}
        </table>
      </div>`,
      session.user,
    );
  });

  app.get("/orders/:id/edit", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    if (!session) return reply.redirect("/login");
    const id = Number((req.params as { id: string }).id);
    const order = ORDERS.find((o) => o.id === id);
    if (!order) {
      reply.code(404);
      reply.type("text/html");
      return shell("Not found", `<div class="panel"><h1>Order not found</h1></div>`, session.user);
    }
    // The edit FORM itself is also shown with no ownership check — believable
    // real-world bugs rarely gate only the final write and nothing else.
    reply.type("text/html");
    return shell(
      `Edit order #${order.id}`,
      `<div class="panel">
        <h1>Edit shipping address — Order #${order.id}</h1>
        <form method="post" action="/orders/${order.id}/address">
          <p><textarea name="address" rows="2">${escapeHtml(order.address)}</textarea></p>
          <button type="submit">Save address</button>
        </form>
        <p><a class="link" href="/orders">&larr; Back to my orders</a></p>
      </div>`,
      session.user,
    );
  });

  // --- The vulnerable handler -------------------------------------------------
  app.post("/orders/:id/address", async (req, reply) => {
    const session = getSession(req.headers.cookie);
    if (!session) return reply.redirect("/login");

    const id = Number((req.params as { id: string }).id);
    const order = ORDERS.find((o) => o.id === id);
    if (!order) {
      reply.code(404);
      reply.type("text/html");
      return shell("Not found", `<div class="panel"><h1>Order not found</h1></div>`, session.user);
    }

    const body = req.body as { address?: string };
    const newAddress = (body.address ?? "").slice(0, 200);

    // VULNERABLE: the write proceeds with no check that order.owner matches
    // the session user. Report the solve only now — at the exact point the
    // unauthorized write actually takes effect.
    if (order.owner !== session.user) {
      await reportSolve(
        ctx,
        `session user "${session.user}" changed the shipping address on order #${order.id} owned by "${order.owner}" via POST /orders/${order.id}/address`,
      );
    }
    order.address = newAddress;

    reply.type("text/html");
    return shell(
      `Order #${order.id} updated`,
      `<div class="panel">
        <h1>Address updated</h1>
        <p>Order #${order.id} will now ship to:</p>
        <p class="panel" style="background:#0b0e13;">${escapeHtml(order.address)}</p>
        <p><a class="link" href="/orders">&larr; Back to my orders</a></p>
      </div>`,
      session.user,
    );
  });

  await startLabApp(app, ctx, "ShopMart");
}

main().catch((err) => {
  console.error("[shopmart-orders] fatal error:", err);
  process.exit(1);
});
