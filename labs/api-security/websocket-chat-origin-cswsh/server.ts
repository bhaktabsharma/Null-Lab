/**
 * ChatRelay — Connect From Anywhere (cross-site WebSocket hijacking)
 *
 * A REAL WebSocket server (@fastify/websocket, built on ws — no simulated
 * protocol) authenticates the upgrade using the session cookie, which
 * browsers attach to a WebSocket handshake exactly as they would to a plain
 * HTTP request — including on a connection initiated by a page on another
 * site entirely. The handler never checks the handshake's Origin header.
 * Recorded only when a connection whose Origin was NOT this app's own host
 * completes and is treated as authenticated.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";
import fastifyWebsocket from "@fastify/websocket";

const ctx = loadLabContext();
const APP = "ChatRelay";
interface User { username: string; password: string; displayName: string; }
const USERS: User[] = [{ username: "alice", password: "practice123", displayName: "Alice Chen" }];
const sessions = makeSessions<{ user: string }>(ctx, "cr_session");
const OWN_HOST = `127.0.0.1:${ctx.port}`;

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#64d8c9", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  await app.register(fastifyWebsocket);
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/", demoLine: "Demo account: <strong>alice</strong> / practice123" });

  app.get("/", async (req, reply) => {
    const s = sessions.read(req);
    reply.type("text/html");
    return shell("ChatRelay", `<div class="panel"><h1>ChatRelay</h1><p class="muted">Connect to ws://…/chat after signing in.</p></div>`, s ? USERS.find((u) => u.username === s.user)?.displayName : undefined);
  });

  // --- The vulnerable handler: no Origin check on the handshake. --------------
  app.get("/chat", { websocket: true }, async (socket, req) => {
    const s = sessions.read(req as unknown as Parameters<typeof sessions.read>[0]);
    if (!s) {
      socket.close(4001, "unauthenticated");
      return;
    }
    const origin = req.headers.origin;
    const isForeignOrigin = typeof origin === "string" && !origin.includes(OWN_HOST) && origin !== "null";

    if (isForeignOrigin) {
      // Awaited BEFORE the welcome frame is sent, so the connection is only
      // ever usable (from the client's point of view) after the solve has
      // actually been recorded — not racing against it.
      await reportSolve(ctx, `an authenticated WebSocket connection completed for user "${s.user}" with handshake Origin "${origin}", which was never checked against this app's own host`);
    }
    socket.send(JSON.stringify({ type: "welcome", user: s.user }));
    socket.on("message", (raw: Buffer) => {
      socket.send(JSON.stringify({ type: "echo", from: s.user, text: raw.toString().slice(0, 200) }));
    });
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[chatrelay] fatal error:", err);
  process.exit(1);
});
