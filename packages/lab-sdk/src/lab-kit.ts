import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LabContext } from "./context.js";
import { parseCookies, signSession, verifySession } from "./session.js";
import { escapeHtml } from "./html.js";

/**
 * Cookies are scoped by HOST, not port, so two labs running at once on
 * 127.0.0.1 would overwrite each other's cookie if they used the same name.
 * Suffixing the instance's own port keeps every running lab's cookies apart
 * (and the name is short enough to read in Burp or browser devtools).
 */
export function scopedCookieName(ctx: LabContext, base: string): string {
  return `${base}_${ctx.port}`;
}

export interface Sessions<T extends object> {
  readonly name: string;
  read(req: FastifyRequest): T | null;
  set(reply: FastifyReply, payload: T): void;
  clear(reply: FastifyReply): void;
}

/** A signed-cookie session for a lab's OWN synthetic users, signed with the instance token. */
export function makeSessions<T extends object>(ctx: LabContext, base: string): Sessions<T> {
  const name = scopedCookieName(ctx, base);
  return {
    name,
    read: (req) => verifySession<T>(ctx.instanceToken, parseCookies(req.headers.cookie)[name]),
    set: (reply, payload) => {
      reply.setCookie(name, signSession(ctx.instanceToken, payload as Record<string, unknown>), {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
      });
    },
    clear: (reply) => {
      reply.clearCookie(name, { path: "/" });
    },
  };
}

/** Reads one plain (unsigned) cookie by its scoped name — for labs where the cookie is the vulnerability. */
export function readPlainCookie(ctx: LabContext, req: FastifyRequest, base: string): string | undefined {
  return parseCookies(req.headers.cookie)[scopedCookieName(ctx, base)];
}

/**
 * Deterministic, unguessable-to-outsiders UUID for a seeded record: derived
 * from the instance token, so it differs for every instance and can't be
 * looked up from the lab's source or from another instance.
 */
export function seededId(ctx: LabContext, label: string): string {
  const h = createHmac("sha256", ctx.instanceToken).update(`id:${label}`).digest("hex");
  const variant = "89ab".charAt(parseInt(h.charAt(16), 16) % 4);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * A short per-instance secret (A–Z / 2–9, no look-alike characters) that a
 * learner can only know by really extracting it from the lab — used as the
 * proof of a blind or data-exfiltration solve.
 */
export function seededSecret(ctx: LabContext, label: string, length = 8, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"): string {
  const bytes = createHmac("sha256", ctx.instanceToken).update(`secret:${label}`).digest();
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet.charAt(bytes[i % bytes.length]! % alphabet.length);
  return out;
}

export interface PasswordUser {
  username: string;
  password: string;
  displayName: string;
}

export interface PasswordLoginOptions<U extends PasswordUser> {
  users: U[];
  sessions: Sessions<{ user: string }>;
  /** Wraps a page body in the lab's own shell. */
  shell: (title: string, body: string, user?: string) => string;
  appName: string;
  /** Where to send the browser after a successful login. */
  home: string;
  /** Optional line under the form, e.g. the demo account. */
  demoLine?: string;
  /** Hook to set extra cookies/state after a successful login. */
  onLogin?: (reply: FastifyReply, user: U) => void;
}

/**
 * Registers GET /login, POST /login (form-encoded or JSON) and GET /logout
 * for a lab's synthetic users — the boilerplate every access-control /
 * session style lab needs, so each lab file contains only its own flaw.
 */
export function registerPasswordLogin<U extends PasswordUser>(app: FastifyInstance, o: PasswordLoginOptions<U>): void {
  app.get("/login", async (req, reply) => {
    const err = (req.query as { error?: string } | undefined)?.error;
    reply.type("text/html");
    return o.shell(
      "Sign in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;">
        <h1>Sign in to ${escapeHtml(o.appName)}</h1>
        ${err ? `<p class="muted" style="color:#e07a7a;">Incorrect username or password.</p>` : ""}
        <form method="post" action="/login">
          <p><input type="text" name="username" placeholder="Username" autocomplete="username" /></p>
          <p><input type="password" name="password" placeholder="Password" autocomplete="current-password" /></p>
          <button type="submit">Sign in</button>
        </form>
        ${o.demoLine ? `<p class="muted" style="margin-top:1rem;">${o.demoLine}</p>` : ""}
      </div>`,
    );
  });

  app.post("/login", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const user = o.users.find(
      (u) => typeof body.username === "string" && typeof body.password === "string" && u.username === body.username && u.password === body.password,
    );
    if (!user) return reply.redirect("/login?error=1");
    o.sessions.set(reply, { user: user.username });
    o.onLogin?.(reply, user);
    return reply.redirect(o.home);
  });

  app.get("/logout", async (_req, reply) => {
    o.sessions.clear(reply);
    return reply.redirect("/login");
  });
}

/** Tiny HTML-escaping function for inline page scripts that render API data with innerHTML-free templates. */
export const CLIENT_ESC_JS = `function esc(s){return String(s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]})}`;
