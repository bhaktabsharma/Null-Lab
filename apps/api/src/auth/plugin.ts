import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import type { ControlDb } from "../db.js";
import { getUserBySession, type AuthedUser } from "./service.js";

export const SESSION_COOKIE = "nulllab_sid";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthedUser | null;
  }
}

export async function registerAuth(app: FastifyInstance, db: ControlDb): Promise<void> {
  await app.register(cookie);

  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.user = getUserBySession(db, token);
  });
}

export function requireAuth(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!req.user) {
    reply.code(401).send({ error: "Sign in (or continue as guest) to do that." });
    return;
  }
  done();
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}
