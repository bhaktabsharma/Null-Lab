import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, CookieClient, type TestApp } from "./helpers.js";

describe("lab: idor-order-tamper (write-based IDOR)", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await startTestApp({ apiPort: 4102, labPortStart: 6150, labPortEnd: 6174 });
  });
  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("does not solve merely by viewing a foreign order's edit form", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>(
      "/api/labs/idor-order-tamper/instances",
      { method: "POST" },
    );
    const jar = new CookieClient(launch.body.instance.baseUrl);
    await jar.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=practice123",
    });

    const viewForeign = await jar.fetch("/orders/502/edit"); // bob's order, alice just viewing the form
    expect(viewForeign.status).toBe(200);

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false);

    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("solves only when the WRITE actually changes a foreign order's address", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>(
      "/api/labs/idor-order-tamper/instances",
      { method: "POST" },
    );
    const jar = new CookieClient(launch.body.instance.baseUrl);
    await jar.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=practice123",
    });

    // Legitimate: alice edits her own order 501 — must NOT solve.
    await jar.fetch("/orders/501/address", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "address=" + encodeURIComponent("99 New Street"),
    });
    let dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false);

    // Exploit: alice tampers with bob's order 502.
    const exploit = await jar.fetch("/orders/502/address", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "address=" + encodeURIComponent("Attacker Controlled Drop Point"),
    });
    expect(exploit.status).toBe(200);
    const html = await exploit.text();
    expect(html).toContain("Attacker Controlled Drop Point");

    dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(true);

    const progress = await client.json<{ xp: number }>("/api/progress");
    expect(progress.body.xp).toBe(75); // easy difficulty

    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });
});

describe("lab: idor-support-ticket", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await startTestApp({ apiPort: 4103, labPortStart: 6175, labPortEnd: 6199 });
  });
  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("solves by reading a foreign ticket thread and reports the correct evidence", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>(
      "/api/labs/idor-support-ticket/instances",
      { method: "POST" },
    );
    const jar = new CookieClient(launch.body.instance.baseUrl);
    await jar.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=priya&password=practice123",
    });

    const ownTicket = await jar.fetch("/tickets/7001");
    expect(ownTicket.status).toBe(200);
    let dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false);

    const foreignTicket = await jar.fetch("/tickets/7002");
    expect(foreignTicket.status).toBe(200);
    const html = await foreignTicket.text();
    expect(html).toContain("duplicate charge");

    dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(true);

    const progress = await client.json<{ xp: number; recentSolves: { labId: string; evidence: string }[] }>(
      "/api/progress",
    );
    expect(progress.body.xp).toBe(50);
    const recent = progress.body.recentSolves.find((s) => s.labId === "idor-support-ticket");
    expect(recent?.evidence).toContain("ticket #7002");
    expect(recent?.evidence).toContain('owned by "marcus"');

    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("a 404 on a nonexistent ticket never solves", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>(
      "/api/labs/idor-support-ticket/instances",
      { method: "POST" },
    );
    const jar = new CookieClient(launch.body.instance.baseUrl);
    await jar.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=priya&password=practice123",
    });
    const missing = await jar.fetch("/tickets/1");
    expect(missing.status).toBe(404);
    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false);
    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });
});
