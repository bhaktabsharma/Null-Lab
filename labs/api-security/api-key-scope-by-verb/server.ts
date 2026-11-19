/**
 * Invoicely — Developer API Keys (a read-only key's scope is checked by endpoint name, not HTTP method)
 *
 * Keys are issued with a scope: "read" or "write". The read-only key's docs
 * promise GET-only access. The scope check keys off a hard-coded list of
 * endpoint PATHS considered "read endpoints" — and /api/invoices/:id appears
 * in that list because GET is the common case, so every method on that path,
 * DELETE included, is let through for a read-only key. Recorded only when a
 * read-only key is used to delete an invoice.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "Invoicely";
const READ_KEY = `inv_read_${seededSecret(ctx, "read-key", 16)}`;
const WRITE_KEY = `inv_write_${seededSecret(ctx, "write-key", 16)}`;
const READ_ENDPOINTS = new Set(["/api/invoices", "/api/invoices/:id"]); // keyed by path only, not by method

const USERS = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
interface Invoice {
  id: string;
  client: string;
  totalCents: number;
}
const invoices: Invoice[] = [
  { id: "inv-1", client: "Orchid Bakery", totalCents: 42000 },
  { id: "inv-2", client: "Basalt Logistics", totalCents: 98000 },
  { id: "inv-3", client: "Fjord Analytics", totalCents: 15000 },
];

const sessions = makeSessions<{ user: string }>(ctx, "invoicely_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#ffb86c",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/developer", label: "Developer" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

function keyScope(key: string | undefined): "read" | "write" | null {
  if (key === READ_KEY) return "read";
  if (key === WRITE_KEY) return "write";
  return null;
}
function pathTemplate(url: string): string {
  return url.split("?")[0]!.replace(/\/api\/invoices\/[^/]+$/, "/api/invoices/:id");
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/developer", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/developer" : "/login"));

  app.get("/developer", async (req, reply) => {
    if (!who(req)) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Developer", `<div class="panel"><h1>Your API keys</h1>
      <p>Read-only key (GET access only): <code>${READ_KEY}</code></p>
      <p>Full-access key: <code>${WRITE_KEY}</code></p>
      <p class="muted">Send either key as <code>Authorization: Bearer &lt;key&gt;</code>.</p></div>`, "Alice Chen");
  });

  // Scope enforcement: PATH is checked against an allow-list; the METHOD is never compared.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const auth = String(req.headers.authorization ?? "");
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const scope = keyScope(key);
    if (!scope) return reply.code(401).send({ error: "invalid or missing API key" });
    if (scope === "read" && !READ_ENDPOINTS.has(pathTemplate(req.url))) {
      return reply.code(403).send({ error: "this key is read-only" });
    }
  });

  app.get("/api/invoices", async () => ({ invoices: invoices.map((i) => ({ id: i.id, client: i.client })) }));
  app.get("/api/invoices/:id", async (req, reply) => {
    const inv = invoices.find((i) => i.id === (req.params as { id: string }).id);
    if (!inv) return reply.code(404).send({ error: "no such invoice" });
    return { invoice: inv };
  });
  app.delete("/api/invoices/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const idx = invoices.findIndex((i) => i.id === id);
    if (idx < 0) return reply.code(404).send({ error: "no such invoice" });
    const [removed] = invoices.splice(idx, 1);
    const auth = String(req.headers.authorization ?? "");
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (keyScope(key) === "read") {
      await reportSolve(ctx, `invoice ${removed!.id} ("${removed!.client}") was deleted using the read-only API key — DELETE on /api/invoices/:id was allowed because the scope check only looks at the path`);
    }
    return { deleted: id };
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[invoicely] fatal error:", err);
  process.exit(1);
});
