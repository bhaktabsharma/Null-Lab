/**
 * ApiGateway — Trust the Header (JWT "alg: none" validation bypass)
 *
 * POST /api/login issues a correctly-signed HS256 token. The verifier,
 * though, reads `alg` from the token's OWN header and — mirroring a real,
 * historical class of JWT library bugs — skips signature verification
 * entirely whenever that header says "none". Recorded only when the admin
 * API accepts a token whose header actually says "none" and which was not
 * produced by this server's real signing secret.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, seededSecret, sign, decode, hmacSha256Base64Url } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "ApiGateway";
const SECRET = seededSecret(ctx, "jwt-signing-secret", 24);
const USERS = [{ username: "alice", password: "practice123", role: "user" }];

/** VULNERABLE: branches on the attacker-controlled header; "none" skips verification entirely. */
function verify(token: string): Record<string, unknown> | null {
  const parts = decode(token);
  if (!parts) return null;
  if (parts.header.alg === "none") {
    return parts.signature === "" ? parts.payload : null; // still requires the conventional empty signature segment
  }
  if (parts.header.alg === "HS256") {
    const expected = hmacSha256Base64Url(parts.signingInput, SECRET);
    return parts.signature === expected ? parts.payload : null;
  }
  return null;
}

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#56c2a8", navLinks: [{ href: "/", label: "Docs" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "ApiGateway",
      `<div class="panel"><h1>ApiGateway</h1><p class="muted">POST /api/login with JSON {"username","password"} to get a bearer token. Send it as <code>Authorization: Bearer &lt;token&gt;</code>.</p>
        <table><tr><th>Method</th><th>Path</th><th>Access</th></tr>
        <tr><td>POST</td><td>/api/login</td><td>Public</td></tr>
        <tr><td>GET</td><td>/api/me</td><td>Any valid token</td></tr>
        <tr><td>GET</td><td>/api/admin/report</td><td>Token with role "admin"</td></tr></table></div>`,
    );
  });

  app.post("/api/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const user = USERS.find((u) => u.username === b.username && u.password === b.password);
    if (!user) return reply.code(401).send({ error: "invalid credentials" });
    const token = sign({ sub: user.username, role: user.role, iat: Math.floor(Date.now() / 1000) }, SECRET);
    return { token };
  });

  app.get("/api/me", async (req, reply) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const claims = token ? verify(token) : null;
    if (!claims) return reply.code(401).send({ error: "invalid or missing token" });
    return { sub: claims.sub, role: claims.role };
  });

  // --- The vulnerable handler: verify() accepts "alg":"none". -----------------
  app.get("/api/admin/report", async (req, reply) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const claims = token ? verify(token) : null;
    if (!claims) return reply.code(401).send({ error: "invalid or missing token" });
    if (claims.role !== "admin") return reply.code(403).send({ error: "admin role required" });

    const parts = decode(token!)!;
    if (parts.header.alg === "none") {
      await reportSolve(ctx, `GET /api/admin/report accepted a token whose header declared alg "none", claiming role "${claims.role}" for subject "${claims.sub}"`);
    }
    return { report: "Q3 revenue: $4.2M (synthetic data)", generatedFor: claims.sub };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[apigateway] fatal error:", err);
  process.exit(1);
});
