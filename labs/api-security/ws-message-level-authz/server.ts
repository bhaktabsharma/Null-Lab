/**
 * Roomcast — Team Chat (WebSocket authorization checked only once, at connect)
 *
 * Connecting to the socket requires a valid session and membership of the
 * room named in the query string — checked once, at connect, and stored on
 * the socket. The protocol is message-based: a single open connection can
 * send a `read_history` message naming ANY room, and the handler trusts the
 * room in the message instead of re-checking it against what the connection
 * was authorized for. Recorded only when history for a room the caller does
 * not belong to is returned over a connection authorized for a different room.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, makeSessions, registerPasswordLogin } from "@nulllab/lab-sdk";
import fastifyWebsocket from "@fastify/websocket";

const ctx = loadLabContext();
const APP = "Roomcast";

const USERS = [
  { username: "alice", password: "practice123", displayName: "Alice Chen" },
  { username: "dana", password: "Dana-Roomcast!91", displayName: "Dana Whitfield" },
];
const ROOMS: Record<string, { members: string[]; history: string[] }> = {
  general: { members: ["alice", "dana"], history: ["alice: good morning", "dana: morning!"] },
  "finance-leads": { members: ["dana"], history: ["dana: Q3 numbers are in — SYNTHETIC: revenue 4.2M, down 3% QoQ", "dana: do not share outside finance yet"] },
};

const sessions = makeSessions<{ user: string }>(ctx, "roomcast_session");
const shell = (title: string, body: string, user?: string) =>
  renderShell(title, body, {
    appName: APP,
    accent: "#ff79c6",
    currentUserLabel: user ?? null,
    navLinks: user ? [{ href: "/rooms", label: "Rooms" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }],
  });

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  await app.register(fastifyWebsocket);
  const who = (req: Parameters<typeof sessions.read>[0]) => sessions.read(req)?.user ?? null;
  registerPasswordLogin(app, { users: USERS, sessions, shell, appName: APP, home: "/rooms", demoLine: "Demo account: <strong>alice</strong> / practice123" });
  app.get("/", async (req, reply) => reply.redirect(who(req) ? "/rooms" : "/login"));

  app.get("/rooms", async (req, reply) => {
    const u = who(req);
    if (!u) return reply.redirect("/login");
    reply.type("text/html");
    const mine = Object.entries(ROOMS).filter(([, r]) => r.members.includes(u)).map(([id]) => id);
    return shell("Rooms", `<div class="panel"><h1>Your rooms</h1><ul>${mine.map((id) => `<li>${id}</li>`).join("")}</ul>
      <p class="muted">Connect with the room's WebSocket workspace, or your own client, to read history.</p></div>`, u);
  });

  // Authorization happens ONCE, at connect: session + room membership. Stored on the socket.
  app.get("/connect", { websocket: true }, async (socket, req) => {
    const u = who(req);
    const requestedRoom = (req.query as { room?: string }).room;
    if (!u || !requestedRoom || !ROOMS[requestedRoom] || !ROOMS[requestedRoom]!.members.includes(u)) {
      socket.close(4001, "not authorized for that room");
      return;
    }
    const authorizedRoom = requestedRoom; // what this connection was actually cleared for

    socket.on("message", async (raw: Buffer) => {
      let msg: { type?: string; room?: string; text?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ error: "malformed message" }));
        return;
      }
      if (msg.type === "read_history") {
        // The vulnerable step: the room comes from the MESSAGE, and is never compared
        // with authorizedRoom — the connection-level check is trusted for every message.
        const room = typeof msg.room === "string" ? msg.room : authorizedRoom;
        const target = ROOMS[room];
        if (!target) {
          socket.send(JSON.stringify({ error: "no such room" }));
          return;
        }
        // Recorded (and awaited) BEFORE the reply is sent, so a client that has received the
        // leaked history can already see the solve reflected through the control plane.
        if (room !== authorizedRoom) {
          await reportSolve(ctx, `a WebSocket connection authorized only for room "${authorizedRoom}" (user "${u}") read the history of room "${room}" via a read_history message naming a different room`);
        }
        socket.send(JSON.stringify({ room, history: target.history }));
        return;
      }
      if (msg.type === "post" && typeof msg.text === "string" && msg.text.length > 0 && msg.text.length <= 300) {
        ROOMS[authorizedRoom]!.history.push(`${u}: ${msg.text}`); // posting stays correctly scoped to the connection's own room
        socket.send(JSON.stringify({ posted: true }));
        return;
      }
      socket.send(JSON.stringify({ error: "unknown message type" }));
    });
  });

  await startLabApp(app, ctx, APP);
}
main().catch((err) => {
  console.error("[roomcast] fatal error:", err);
  process.exit(1);
});
