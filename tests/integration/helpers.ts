import fs from "node:fs";
import path from "node:path";
import { buildApp, type NulllabApp } from "../../apps/api/src/app.js";
import type { Env } from "../../apps/api/src/env.js";
import { closeBrowser } from "../../apps/api/src/instances/admin-bot.js";
import { getLabProxy } from "./proxy.js";

/**
 * If NULLLAB_CHROMIUM_EXECUTABLE isn't already set, look for a Chromium
 * build under PLAYWRIGHT_BROWSERS_PATH (or Playwright's default cache
 * location) so the admin-bot tests work out of the box in CI/sandboxed
 * environments without requiring a network-dependent `playwright install`
 * at test time. A normal developer machine with Playwright's own browser
 * download will simply not need this — it only fires when nothing was
 * already configured.
 */
function detectLocalChromium(): string | undefined {
  if (process.env.NULLLAB_CHROMIUM_EXECUTABLE) return process.env.NULLLAB_CHROMIUM_EXECUTABLE;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.HOME ?? "", ".cache/ms-playwright")].filter(
    (p): p is string => !!p,
  );
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith("chromium-"));
    for (const dir of dirs) {
      const candidate = path.join(root, dir, "chrome-linux", "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface TestApp extends NulllabApp {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Starts a real NULLLAB control-plane API on a real port (required: lab
 * target child processes report solves back over real HTTP, so the
 * control plane must actually be reachable, not just app.inject()-able).
 * Each integration test file passes its own non-overlapping apiPort and
 * lab port range so files can run one after another without colliding —
 * see vitest.config.ts (fileParallelism: false) for why that's safe.
 */
export async function startTestApp(opts: {
  apiPort: number;
  labPortStart: number;
  labPortEnd: number;
  envOverrides?: Partial<Env>;
}): Promise<TestApp> {
  process.env.NULLLAB_TEST_SILENT = "1";
  const built = await buildApp({
    envOverrides: {
      API_PORT: opts.apiPort,
      DATABASE_PATH: ":memory:",
      SESSION_SECRET: "test-session-secret-0123456789abcdef",
      WEB_ORIGIN: "http://localhost:5173",
      RUNTIME_MODE: "process",
      LAB_PORT_RANGE_START: opts.labPortStart,
      LAB_PORT_RANGE_END: opts.labPortEnd,
      LAB_INSTANCE_IDLE_MINUTES: 30,
      LAB_INSTANCE_MAX_MINUTES: 120,
      NULLLAB_CHROMIUM_EXECUTABLE: detectLocalChromium(),
      NULLLAB_CHROMIUM_NO_SANDBOX: true,
      ...opts.envOverrides,
    },
  });

  await built.app.listen({ port: opts.apiPort, host: "127.0.0.1" });

  // Proxy mode: let the proxy resolve "which lab is on this port right now" from the
  // control plane's own instance table, so tests that launch labs straight through the
  // API (not via lab-harness `launch`) are routed through the proxy as well.
  const removeResolver = (await getLabProxy())?.addResolver((port) => {
    if (port < opts.labPortStart || port > opts.labPortEnd) return undefined;
    const row = built.db
      .prepare(`SELECT lab_id FROM lab_instances WHERE port = ? AND status IN ('starting','running') ORDER BY created_at DESC LIMIT 1`)
      .get(port) as { lab_id: string } | undefined;
    return row?.lab_id;
  });

  return {
    ...built,
    baseUrl: `http://127.0.0.1:${opts.apiPort}`,
    async close() {
      // Proxy mode: the control plane's `solves` table is written only by the server-side
      // verifier, so it is the authoritative record of which labs were really solved while
      // all learner traffic to them went through the proxy. Read it before the DB closes.
      const proxy = await getLabProxy();
      if (proxy) {
        const solved = built.db.prepare("SELECT DISTINCT lab_id FROM solves").all() as { lab_id: string }[];
        for (const row of solved) proxy.markSolved(row.lab_id);
      }
      removeResolver?.();
      await built.app.close();
      built.db.close();
      await closeBrowser();
    },
  };
}

/** Thin fetch wrapper that carries a cookie jar across calls, like a browser tab. */
export class CookieClient {
  private jar = new Map<string, string>();

  constructor(private readonly baseUrl: string) {}

  /** Sets (or overwrites) a cookie by hand — what a learner does in browser devtools or Burp. */
  setCookie(name: string, value: string): void {
    this.jar.set(name, value);
  }

  getCookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  cookieNames(): string[] {
    return [...this.jar.keys()];
  }

  private cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private captureSetCookies(res: Response): void {
    const raw = (res.headers as any).getSetCookie?.() as string[] | undefined;
    const cookies = raw ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
    for (const c of cookies) {
      const pair = c.split(";")[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      this.jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookieHeader = this.cookieHeader();
    if (cookieHeader) headers.set("cookie", cookieHeader);
    const url = `${this.baseUrl}${path}`;
    // NULLLAB_TEST_PROXY=1: traffic to a launched lab goes through the local
    // forward proxy (see proxy.ts), the way a learner's Burp traffic would.
    // Control-plane calls (the API port) are never registered, so they stay direct.
    const proxy = await getLabProxy();
    const res = proxy?.handles(url)
      ? await proxy.fetch(url, { ...init, headers, redirect: "manual" })
      : await fetch(url, { ...init, headers, redirect: "manual" });
    this.captureSetCookies(res);
    return res;
  }

  async json<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await this.fetch(path, init);
    const body = (await res.json().catch(() => null)) as T;
    return { status: res.status, body };
  }
}

export function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
