import { chromium, type Browser } from "playwright-core";
import type { Env } from "../env.js";

let sharedBrowser: Browser | null = null;

async function getBrowser(env: Env): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  sharedBrowser = await chromium.launch({
    headless: true,
    executablePath: env.NULLLAB_CHROMIUM_EXECUTABLE || undefined,
    args: env.NULLLAB_CHROMIUM_NO_SANDBOX ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
  return sharedBrowser;
}

export async function closeBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
}

export interface SimulateAdminVisitRequest {
  env: Env;
  targetBaseUrl: string;
  instanceToken: string;
  /** The path (and query string) the admin bot should navigate to — e.g. "/search?q=..." */
  path: string;
  /** The lab's own admin-session cookie name. */
  adminCookieName: string;
}

export interface SimulateAdminVisitResult {
  ok: boolean;
  error?: string;
}

/**
 * Logs a headless browser in as the lab's simulated admin (via a direct
 * server-to-server call — the instance token never reaches the browser),
 * then navigates that authenticated browser session to the path the
 * person being tested supplied. If their payload runs, it is the PAGE's
 * own script that reports the solve (via the normal lab-sdk reportSolve
 * contract, from the lab's /collect endpoint) — this function only
 * drives the visit, it never inspects the page or decides solved/not.
 */
export async function simulateAdminVisit(req: SimulateAdminVisitRequest): Promise<SimulateAdminVisitResult> {
  let context;
  try {
    // 1. Mint the admin session server-to-server. The instance token is
    // used here and ONLY here — never passed to the browser.
    const sessionRes = await fetch(`${req.targetBaseUrl}/__internal/admin-session`, {
      method: "POST",
      headers: { "x-instance-token": req.instanceToken },
      signal: AbortSignal.timeout(5000),
    });
    if (!sessionRes.ok) {
      return { ok: false, error: `This lab's target did not accept an admin session (${sessionRes.status}).` };
    }
    const setCookie = sessionRes.headers.get("set-cookie");
    if (!setCookie) {
      return { ok: false, error: "This lab's target did not return an admin session cookie." };
    }
    const cookieValue = setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";
    const url = new URL(req.targetBaseUrl);

    const browser = await getBrowser(req.env);
    context = await browser.newContext();
    await context.addCookies([
      {
        name: req.adminCookieName,
        value: cookieValue,
        domain: url.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    const page = await context.newPage();
    const visitUrl = new URL(req.path, req.targetBaseUrl).toString();
    await page.goto(visitUrl, { waitUntil: "load", timeout: 8000 });
    // Give any async exfiltration (fetch/image-beacon fired by the
    // injected payload) a moment to actually reach the lab target.
    await page.waitForTimeout(800);

    // Clickjacking labs mark the spot a real visitor would visually click
    // (the decoy) with this attribute. If the page the bot was sent to has
    // one, perform a REAL pointer click there — page.mouse.click dispatches
    // an actual input event at that screen position, so if something else
    // (an invisible, stacked iframe) occupies that exact point, the click
    // physically lands on it, just as it would for a real victim. This is
    // never targeted at a selector — only at coordinates — so it can't be
    // fooled into "clicking through" to an element Playwright decided was
    // the intended target.
    const ckTarget = page.locator("[data-ck-target]").first();
    if (await ckTarget.count()) {
      const box = await ckTarget.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(500);
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
