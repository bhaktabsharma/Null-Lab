/**
 * MemberGate — Two Kinds of Wrong (username/account enumeration)
 *
 * POST /login returns a distinct message (and, for good measure, a distinct
 * status code) for "no such user" versus "wrong password" — letting an
 * attacker confirm which usernames exist without ever knowing a password.
 * Recorded only when the attempt that reveals this is made against the REAL
 * seeded username (proving account existence was actually confirmed, not
 * just that two different decoys both say "no such user").
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "MemberGate";
const REAL_USER = "priya";
const REAL_PASSWORD = seededSecret(ctx, "priya-password", 16);
const DECOYS = ["priyanka", "priya_", "priya1"]; // plausible but nonexistent

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#d98fd2", navLinks: [{ href: "/login", label: "Sign in" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => reply.redirect("/login"));

  app.get("/login", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Sign in",
      `<div class="panel" style="max-width:380px;margin:3rem auto;"><h1>Sign in to MemberGate</h1>
        <form method="post" action="/login"><p><input type="text" name="username" placeholder="Username" /></p>
        <p><input type="password" name="password" placeholder="Password" /></p><button type="submit">Sign in</button></form></div>`,
    );
  });

  // --- The vulnerable handler: the two failure reasons are distinguishable. ---
  app.post("/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof b.username === "string" ? b.username : "";
    const password = typeof b.password === "string" ? b.password : "";
    reply.type("text/html");

    if (username !== REAL_USER) {
      reply.code(404); // VULNERABLE: distinct status + message for "no such account"
      if (DECOYS.includes(username) || username.length > 0) {
        // confirms NON-existence, which is the safe half of the leak
      }
      return shell("Sign in", `<div class="panel"><p style="color:#e07a7a;">No account found with that username.</p></div>`);
    }

    if (password !== REAL_PASSWORD) {
      reply.code(401); // VULNERABLE: distinct status + message for "account exists, wrong password"
      await reportSolve(ctx, `POST /login for the real username "${REAL_USER}" returned a distinct "incorrect password" response, confirming the account exists without any valid password`);
      return shell("Sign in", `<div class="panel"><p style="color:#e07a7a;">Incorrect password.</p></div>`);
    }

    reply.type("text/html");
    return shell("Welcome", `<div class="panel"><h1>Welcome, ${REAL_USER}</h1></div>`);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[membergate] fatal error:", err);
  process.exit(1);
});
