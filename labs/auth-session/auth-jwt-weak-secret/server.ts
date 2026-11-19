/**
 * ApiGateway — A Secret Worth Guessing (JWT weak/guessable HMAC secret)
 *
 * Unlike the alg:none lab in this same family, verification here is fully
 * correct: HS256 only, signature genuinely checked against the real
 * secret. The vulnerability is the SECRET itself — one short, common word
 * from a small, fixed list, not a long random value — so it can be
 * recovered entirely offline by recomputing the HMAC for each candidate
 * and comparing it to a real token's own signature (exactly the jwt_tool /
 * hashcat mode 16500 technique). Recorded only when the admin API accepts a
 * token the CALLER signed themselves with a forged role claim — proving the
 * secret was actually recovered, not merely that a valid token was replayed.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, sign, decode, hmacSha256Base64Url } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "ApiGateway";
const WORDLIST = ["dragon", "sunshine", "letmein", "football", "monkey123", "iloveyou", "starfish", "qwerty99"];
const SECRET = WORDLIST[parseInt(ctx.instanceToken.slice(0, 8), 16) % WORDLIST.length]!;
const USERS = [{ username: "alice", password: "practice123", role: "user" }];

function verify(token: string): Record<string, unknown> | null {
  const parts = decode(token);
  if (!parts || parts.header.alg !== "HS256") return null; // alg:none is correctly rejected here
  const expected = hmacSha256Base64Url(parts.signingInput, SECRET);
  return parts.signature === expected ? parts.payload : null;
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
      `<div class="panel"><h1>ApiGateway (HS256, real signing)</h1><p class="muted">POST /api/login with JSON {"username","password"} to get a bearer token.</p>
        <table><tr><th>Method</th><th>Path</th><th>Access</th></tr>
        <tr><td>POST</td><td>/api/login</td><td>Public</td></tr>
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

  // --- The vulnerable surface: the secret itself, not the verification logic. --
  app.get("/api/admin/report", async (req, reply) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const claims = token ? verify(token) : null;
    if (!claims) return reply.code(401).send({ error: "invalid or missing token" });
    if (claims.role !== "admin") return reply.code(403).send({ error: "admin role required" });

    const issuedByServer = USERS.some((u) => u.username === claims.sub && u.role === "admin");
    if (!issuedByServer) {
      await reportSolve(ctx, `GET /api/admin/report accepted a token for subject "${claims.sub}" claiming role "admin", which this server never issued — the weak HS256 secret was recovered and used to forge it`);
    }
    return { report: "Q3 revenue: $4.2M (synthetic data)", generatedFor: claims.sub };
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[apigateway-weak-secret] fatal error:", err);
  process.exit(1);
});
