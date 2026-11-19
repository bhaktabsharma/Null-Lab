export interface ShellOptions {
  appName: string;
  navLinks?: { href: string; label: string }[];
  currentUserLabel?: string | null;
  accent?: string;
}

/**
 * A small, dependency-free HTML shell so every lab target looks like a
 * believable, distinct application rather than a bare JSON API or a
 * NULLLAB-branded page. Each target app sets its own appName/accent/nav.
 * This is intentionally plain server-rendered HTML + inline CSS — no build
 * step is required to launch dozens of isolated target instances quickly.
 */
export function renderShell(title: string, bodyHtml: string, opts: ShellOptions): string {
  const accent = opts.accent ?? "#3fb8af";
  const nav = (opts.navLinks ?? [])
    .map((l) => `<a href="${l.href}">${escapeHtml(l.label)}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · ${escapeHtml(opts.appName)}</title>
<style>
  :root { --accent: ${accent}; --bg: #0e1116; --panel: #161b22; --border: #262c36; --text: #e6e8eb; --muted: #8b94a3; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); }
  header { display: flex; align-items: center; gap: 1.5rem; padding: 0.9rem 1.5rem; background: var(--panel); border-bottom: 1px solid var(--border); }
  header .brand { font-weight: 700; letter-spacing: 0.02em; color: var(--accent); }
  header nav a { color: var(--muted); text-decoration: none; margin-right: 1.1rem; font-size: 0.92rem; }
  header nav a:hover { color: var(--text); }
  header .user { margin-left: auto; font-size: 0.85rem; color: var(--muted); }
  main { max-width: 920px; margin: 2rem auto; padding: 0 1.5rem; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; }
  h1 { font-size: 1.35rem; margin: 0 0 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  input, textarea, select, button { font: inherit; }
  input[type=text], input[type=password], input[type=search], textarea { background: #0b0e13; border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 0.5rem 0.65rem; width: 100%; }
  button, .btn { background: var(--accent); color: #06110f; border: none; border-radius: 6px; padding: 0.5rem 0.9rem; font-weight: 600; cursor: pointer; }
  .btn.secondary { background: transparent; border: 1px solid var(--border); color: var(--text); }
  a.link { color: var(--accent); }
  .muted { color: var(--muted); font-size: 0.85rem; }
  .pill { display: inline-block; font-size: 0.72rem; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <div class="brand">${escapeHtml(opts.appName)}</div>
  <nav>${nav}</nav>
  ${opts.currentUserLabel ? `<div class="user">Signed in as <strong>${escapeHtml(opts.currentUserLabel)}</strong></div>` : ""}
</header>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

export function escapeHtml(input: string): string {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
