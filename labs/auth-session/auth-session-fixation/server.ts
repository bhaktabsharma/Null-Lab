/**
 * HelpDeskPro — The Session That Was Already There (session fixation)
 *
 * The session id can be set directly via ?sid=, as a stand-in for any
 * mechanism that lets an attacker plant a known session identifier on a
 * victim (a crafted link, a shared/public terminal, a subdomain cookie).
 * Login never rotates the id — it just marks whatever session is already
 * present as authenticated. Recorded only when a login succeeds on a
 * session that was first created by an explicit, attacker-supplied ?sid=
 * rather than one the server minted itself — the solve fires at the exact
 * point a real victim's login would hand control back to the attacker, with
 * no separate "verify" step required.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell } from "@nulllab/lab-sdk";
import { randomBytes } from "node:crypto";

const ctx = loadLabContext();
const APP = "HelpDeskPro";
const USER = { username: "alice", password: "practice123", displayName: "Alice Chen" };
const COOKIE = `hd_sid_${ctx.port}`;

interface Session {
  authenticated: boolean;
  user: string | null;
  /** True when this session id's FIRST appearance was an explicit ?sid= value rather than one this server minted. */
  attackerChosen: boolean;
}
const sessions = new Map<string, Session>();
function parseCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
}

function shell(title: string, body: string, user?: string): string {
  return renderShell(title, body, { appName: APP, accent: "#f0a860", currentUserLabel: user ?? null, navLinks: user ? [{ href: "/tickets", label: "Tickets" }, { href: "/logout", label: "Log out" }] : [{ href: "/login", label: "Log in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  // VULNERABLE: honours an attacker-supplied session id instead of only ever minting its own.
  app.addHook("onRequest", async (req, reply) => {
    const fromQuery = (req.query as { sid?: string } | undefined)?.sid;
    let sid = fromQuery ?? parseCookie(req.headers.cookie, COOKIE);
    if (!sid || !sessions.has(sid)) {
      const attackerChosen = fromQuery !== undefined;
      sid = fromQuery ?? randomBytes(16).toString("hex");
      sessions.set(sid, { authenticated: false, user: null, attackerChosen });
    }
    reply.setCookie(COOKIE, sid, { path: "/", httpOnly: true, sameSite: "lax" });
    (req as { sid?: string }).sid = sid;
  });
  const sessionOf = (req: { sid?: string }) => sessions.get(req.sid!)!;

  app.get("/", async (req, reply) => reply.redirect(sessionOf(req as { sid?: string }).authenticated ? "/tickets" : "/login"));

  app.get("/login", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Sign in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Sign in to HelpDeskPro</h1>
      <form method="post" action="/login"><p><input type="text" name="username" placeholder="Username" /></p>
      <p><input type="password" name="password" placeholder="Password" /></p><button type="submit">Sign in</button></form>
      <p class="muted">Demo: <strong>alice</strong> / practice123</p></div>`,
    );
  });

  app.post("/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    reply.type("text/html");
    if (b.username !== USER.username || b.password !== USER.password) {
      reply.code(401);
      return shell(
        "Sign in",
        `<div class="panel" style="max-width:380px;margin:3rem auto;"><p style="color:#e07a7a;">Incorrect username or password.</p>
        <a class="link" href="/login">Try again</a></div>`,
      );
    }
    // VULNERABLE: the EXISTING session (possibly attacker-planted) is upgraded in place, never replaced.
    const sess = sessionOf(req as unknown as { sid?: string });
    sess.authenticated = true;
    sess.user = USER.username;

    if (sess.attackerChosen) {
      await reportSolve(ctx, `login succeeded on session id "${(req as unknown as { sid?: string }).sid}", whose first appearance was an attacker-supplied ?sid=, not a server-minted value`);
    }
    return reply.redirect("/tickets");
  });

  app.get("/tickets", async (req, reply) => {
    const s = sessionOf(req as { sid?: string });
    if (!s.authenticated) return reply.redirect("/login");
    reply.type("text/html");
    return shell("Tickets", `<div class="panel"><h1>Open tickets</h1><p class="muted">3 tickets assigned to you.</p></div>`, s.user ?? undefined);
  });

  app.get("/logout", async (req, reply) => {
    sessionOf(req as { sid?: string }).authenticated = false;
    return reply.redirect("/login");
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[helpdeskpro] fatal error:", err);
  process.exit(1);
});
