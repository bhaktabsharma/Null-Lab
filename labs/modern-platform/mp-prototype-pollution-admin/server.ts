/**
 * SettingsPanel — Just Merge It (client-side prototype pollution)
 *
 * The page stores a JSON settings blob (via localStorage, entirely
 * client-side) and re-applies it on load with a recursive `deepMerge` that
 * copies every key from the saved object onto a `config` object — including
 * `__proto__`, which a deep merge must explicitly exclude to be safe. A
 * saved payload containing `{"__proto__":{"isAdmin":true}}` therefore adds
 * `isAdmin` directly to `Object.prototype`, so EVERY plain object in the
 * page — including the one the page's own `isAdmin()` check reads from —
 * appears to have it. The admin-bot loads the page with that payload
 * pre-seeded (via `?settings=`) and checks the page's own exposed result.
 * Nothing here ever touches the server: the vulnerability is pure
 * client-side JavaScript, and the lab's HTTP surface only serves the page.
 */
import { createLabApp, startLabApp, loadLabContext, reportSolve, renderShell, registerAdminSession } from "@nulllab/lab-sdk";

const ctx = loadLabContext();
const APP = "SettingsPanel";
// Required for the admin-bot's standard mint-cookie-then-visit flow, even
// though THIS lab's vulnerability is purely client-side and never reads it.
const ADMIN_COOKIE = "sp_admin_unused";

function shell(title: string, body: string): string {
  return renderShell(title, body, { appName: APP, accent: "#c77dff", navLinks: [{ href: "/", label: "Settings" }] });
}

const PAGE_SCRIPT = `
// VULNERABLE: a textbook-unsafe recursive merge — no key exclusion at all.
function deepMerge(target, source) {
  for (const key in source) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      if (typeof target[key] !== "object" || target[key] === null) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

const config = { theme: "light", fontSize: "medium" };

function isAdmin() {
  // A check elsewhere in the app that trusts config.isAdmin — plausible,
  // ordinary-looking code, not itself the bug.
  return config.isAdmin === true;
}

const params = new URLSearchParams(location.search);
const raw = params.get("settings") || localStorage.getItem("settings-panel-prefs") || "{}";
let parsed = {};
try { parsed = JSON.parse(raw); } catch (e) { /* ignore malformed input */ }
deepMerge(config, parsed);
localStorage.setItem("settings-panel-prefs", JSON.stringify({ theme: config.theme, fontSize: config.fontSize }));

document.getElementById("result").textContent = "isAdmin(): " + isAdmin();
if (isAdmin()) {
  fetch("/__collect-pollution-proof");
}
`;

async function main() {
  const app = await createLabApp(ctx, { appName: APP });
  registerAdminSession(app, ctx, ADMIN_COOKIE);

  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return shell(
      "Settings",
      `<div class="panel"><h1>Settings</h1><p class="muted">Pass settings via ?settings=&lt;JSON&gt; or save them normally.</p>
        <p id="result" class="pill"></p></div>
       <script>${PAGE_SCRIPT}</script>`,
    );
  });

  app.get("/__collect-pollution-proof", async (_req, reply) => {
    await reportSolve(ctx, `the page's own isAdmin() check returned true after a settings merge polluted Object.prototype — no session was ever actually granted admin`);
    reply.type("text/plain");
    return "ok";
  });

  await startLabApp(app, ctx, APP);
}

main().catch((err) => {
  console.error("[settingspanel] fatal error:", err);
  process.exit(1);
});
