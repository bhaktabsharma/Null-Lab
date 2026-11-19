/**
 * GreetCards — Template Surprise (server-side template injection)
 *
 * The card text is built by concatenating the recipient's name into the
 * template SOURCE and then rendering it. A name like `{{ ... }}` is therefore
 * evaluated as an expression against the render context, which also carries
 * app settings. The engine is a constrained, hand-written, data-only
 * evaluator (see mini-template.ts): it can read the context and nothing else.
 * Recorded only when the rendered output contains the secret key.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, renderTemplate, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "GreetCards";
const SECRET_KEY = `SK-${seededSecret(ctx, "secret-key", 16)}`;
const OCCASIONS = ["birthday", "graduation", "thank-you", "new job"];

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#ff8a5c", navLinks: [{ href: "/", label: "New card" }] });
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "New card",
      `<div class="panel"><h1>Make a greeting card</h1>
        <form method="get" action="/card"><p><input type="text" name="name" placeholder="Recipient's name" /></p>
        <p><select name="occasion">${OCCASIONS.map((o) => `<option>${o}</option>`).join("")}</select></p><button type="submit">Preview card</button></form></div>`,
    );
  });

  // --- The vulnerable handler -------------------------------------------------
  app.get("/card", async (req, reply) => {
    const q = req.query as { name?: string; occasion?: string };
    const name = String(q.name ?? "friend");
    const occasion = OCCASIONS.includes(String(q.occasion)) ? String(q.occasion) : "";
    reply.type("text/html");
    if (name.length > 300) {
      reply.code(400);
      return shell("Too long", `<div class="panel"><p>That name is too long.</p></div>`);
    }

    // VULNERABLE: the visitor's name is concatenated into the template source.
    const source = `Dear ${name}, wishing you a wonderful {{ occasion | default('day') }}! — {{ sender.name }}`;
    const rendered = renderTemplate(source, {
      occasion,
      sender: { name: "The GreetCards Team" },
      config: { APP_NAME: APP, DEBUG: false, SECRET_KEY },
    });

    if (rendered.includes(SECRET_KEY)) {
      await reportSolve(ctx, `GET /card rendered a template whose output contained the application's secret key (name=${JSON.stringify(name.slice(0, 80))})`);
    }
    return shell(
      "Your card",
      `<div class="panel"><h1>Your card</h1><div class="panel" style="background:#0b0e13;font-size:1.15rem;">${escapeHtml(rendered)}</div>
        <p><a class="link" href="/">Make another</a></p></div>`,
    );
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[greetcards] fatal error:", err);
  process.exit(1);
});
