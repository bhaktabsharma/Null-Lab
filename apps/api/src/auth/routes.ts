import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlDb } from "../db.js";
import { createGuestUser, registerUser, loginUser, deleteSession } from "./service.js";
import { setSessionCookie, clearSessionCookie, SESSION_COOKIE, requireAuth } from "./plugin.js";
import type { PublicUser } from "@nulllab/shared";

const CredentialsSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

function toPublicUser(u: { id: string; username: string | null; isGuest: boolean; xp: number; createdAt: string }): PublicUser {
  return { id: u.id, username: u.username ?? "", isGuest: u.isGuest, xp: u.xp, createdAt: u.createdAt };
}

export async function authRoutes(app: FastifyInstance, db: ControlDb, cookieSecure: boolean): Promise<void> {
  app.post("/api/auth/guest", async (_req, reply) => {
    const { user, sessionToken, expiresAt } = createGuestUser(db);
    setSessionCookie(reply, sessionToken, expiresAt, cookieSecure);
    return { user: toPublicUser(user) };
  });

  app.post("/api/auth/register", async (req, reply) => {
    const parsed = CredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    }
    const result = registerUser(db, parsed.data.username, parsed.data.password);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    setSessionCookie(reply, result.sessionToken, result.expiresAt, cookieSecure);
    return { user: toPublicUser(result.user) };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const parsed = CredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    }
    const result = loginUser(db, parsed.data.username, parsed.data.password);
    if (!result.ok) return reply.code(401).send({ error: result.error });
    setSessionCookie(reply, result.sessionToken, result.expiresAt, cookieSecure);
    return { user: toPublicUser(result.user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    deleteSession(db, req.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
    return { user: toPublicUser(req.user!) };
  });
}
