/**
 * NetOps Console — Ping Tool (OS command injection, SANDBOXED MOCK SHELL)
 *
 * The host field is concatenated into `ping -c 1 <host>` and handed to
 * runMockShell — a SIMULATED interpreter over a virtual filesystem. It
 * understands `;`, `&&`, `||`, `|`, newlines, quotes and `$()`, so injection
 * behaves like the real thing, but it never starts a process or touches the
 * host. Recorded only when the command output contains the token from the
 * config file — something `ping` can never print.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, escapeHtml, runMockShell, seededSecret } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "NetOps Console";
const TOKEN = `NETOPS-${seededSecret(ctx, "api-token", 12)}`;

const VFS: Record<string, string> = {
  "/opt/netops/config.ini": `[netops]\nmode=lab\nregion=eu-west\napi_token=${TOKEN}\n`,
  "/opt/netops/README.txt": "NetOps diagnostics helper. Internal use only.\n",
  "/etc/motd": "Authorized use only. Activity may be monitored.\n",
  "/var/log/netops.log": "2026-10-23 09:12 diagnostics started\n2026-10-23 09:13 ping gateway.lab ok\n",
};

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#4de0a0", navLinks: [{ href: "/", label: "Diagnostics" }] });
}

function page(output?: string, host?: string): string {
  return shell(
    "Diagnostics",
    `<div class="panel"><h1>Network diagnostics</h1><p class="muted">Check that a host is reachable. Try <code>gateway.lab</code> or <code>localhost</code>.</p>
      <form method="post" action="/diagnostics"><p><input type="text" name="host" value="${escapeHtml(host ?? "")}" placeholder="hostname or IP" /></p><button type="submit">Run ping</button></form>
      ${output !== undefined ? `<pre style="margin-top:1rem;">${escapeHtml(output)}</pre>` : ""}</div>`,
  );
}

async function main() {
  const app = await createLabApp(ctx, { appName: APP });

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return page();
  });

  // --- The vulnerable handler -------------------------------------------------
  app.post("/diagnostics", async (req, reply) => {
    const host = (req.body as { host?: unknown } | null)?.host;
    reply.type("text/html");
    if (typeof host !== "string" || host.length === 0 || host.length > 200) {
      reply.code(400);
      return page("Please enter a hostname (up to 200 characters).");
    }
    // VULNERABLE: user input concatenated into a command line.
    const commandLine = `ping -c 1 ${host}`;
    const result = runMockShell(commandLine, VFS);
    if (result.output.includes(TOKEN)) {
      await reportSolve(ctx, `command line "${commandLine}" ran [${result.executed.map((c) => c.name).join(", ")}] and its output contained the API token`);
    }
    return page(result.output, host);
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[netops-console] fatal error:", err);
  process.exit(1);
});
