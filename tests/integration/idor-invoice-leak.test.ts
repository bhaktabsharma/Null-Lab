import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, CookieClient, type TestApp } from "./helpers.js";

describe("lab: idor-invoice-leak (end-to-end through the real control plane + a real spawned process)", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await startTestApp({ apiPort: 4101, labPortStart: 6100, labPortEnd: 6149 });
  });

  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("loads the lab into the catalogue", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const { status, body } = await client.json<{ labs: { id: string }[] }>("/api/labs");
    expect(status).toBe(200);
    expect(body.labs.some((l) => l.id === "idor-invoice-leak")).toBe(true);
  });

  it("rejects unauthenticated instance launch", async () => {
    const res = await fetch(`${testApp.baseUrl}/api/labs/idor-invoice-leak/instances`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("launches, exploits the IDOR, and auto-verifies + awards XP exactly once", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });

    const launch = await client.json<{ instance: { id: string; baseUrl: string; status: string } }>(
      "/api/labs/idor-invoice-leak/instances",
      { method: "POST" },
    );
    expect(launch.status).toBe(200);
    expect(launch.body.instance.status).toBe("running");
    expect(launch.body.instance.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:61\d\d$/);

    const target = launch.body.instance.baseUrl;

    // --- Normal legitimate use: log in as alice, view her own invoice ---
    const targetJar = new CookieClient(target);
    const loginRes = await targetJar.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=practice123",
    });
    expect(loginRes.status).toBe(302);

    const ownInvoice = await targetJar.fetch("/invoices/1001");
    expect(ownInvoice.status).toBe(200);
    const ownHtml = await ownInvoice.text();
    expect(ownHtml).toContain("alice");

    // Not solved yet — only legitimate access happened so far.
    const beforeExploit = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(beforeExploit.body.instance.solved).toBe(false);

    // --- The actual IDOR exploit: alice's session reads bob's invoice ---
    const exploitRes = await targetJar.fetch("/invoices/1002");
    expect(exploitRes.status).toBe(200);
    const exploitHtml = await exploitRes.text();
    expect(exploitHtml).toContain("bob");
    expect(exploitHtml).toContain("899.00");

    // The control plane should already reflect the solve — reportSolve is
    // awaited inside the lab handler before it responds to the client.
    const afterExploit = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(afterExploit.body.instance.solved).toBe(true);

    const progress = await client.json<{ xp: number; totalSolved: number }>("/api/progress");
    expect(progress.body.xp).toBe(50); // beginner difficulty
    expect(progress.body.totalSolved).toBe(1);

    const catalogAfter = await client.json<{ labs: { id: string; solved: boolean }[] }>("/api/labs");
    expect(catalogAfter.body.labs.find((l) => l.id === "idor-invoice-leak")?.solved).toBe(true);

    // --- Replay: solving again must NOT award XP a second time ---
    await targetJar.fetch("/invoices/1002");
    const progressAfterReplay = await client.json<{ xp: number }>("/api/progress");
    expect(progressAfterReplay.body.xp).toBe(50);

    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("does not solve when a user views their own invoice, or hits a non-existent one", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });

    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/idor-invoice-leak/instances", {
      method: "POST",
    });
    const target = launch.body.instance.baseUrl;
    const targetJar = new CookieClient(target);
    await targetJar.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=bob&password=hunter22",
    });

    await targetJar.fetch("/invoices/1002"); // bob's own invoice — legitimate
    await targetJar.fetch("/invoices/1003"); // bob's own invoice — legitimate
    const missing = await targetJar.fetch("/invoices/4242"); // doesn't exist
    expect(missing.status).toBe(404);

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false);

    const progress = await client.json<{ xp: number }>("/api/progress");
    expect(progress.body.xp).toBe(0);

    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("keeps two different users' progress fully isolated", async () => {
    const userA = new CookieClient(testApp.baseUrl);
    const userB = new CookieClient(testApp.baseUrl);
    await userA.fetch("/api/auth/guest", { method: "POST" });
    await userB.fetch("/api/auth/guest", { method: "POST" });

    const launchA = await userA.json<{ instance: { id: string; baseUrl: string } }>(
      "/api/labs/idor-invoice-leak/instances",
      { method: "POST" },
    );
    const jarA = new CookieClient(launchA.body.instance.baseUrl);
    await jarA.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=practice123",
    });
    await jarA.fetch("/invoices/1002"); // user A solves it

    const progressA = await userA.json<{ xp: number }>("/api/progress");
    const progressB = await userB.json<{ xp: number }>("/api/progress");
    expect(progressA.body.xp).toBe(50);
    expect(progressB.body.xp).toBe(0); // user B untouched by user A's solve

    await userA.fetch(`/api/instances/${launchA.body.instance.id}/stop`, { method: "POST" });
  });

  it("reset gives a genuinely fresh instance (new id, new port, instance-level unsolved) without losing earned XP", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });

    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/idor-invoice-leak/instances", {
      method: "POST",
    });
    const jar = new CookieClient(launch.body.instance.baseUrl);
    await jar.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=practice123",
    });
    await jar.fetch("/invoices/1002");
    const xpAfterSolve = (await client.json<{ xp: number }>("/api/progress")).body.xp;
    expect(xpAfterSolve).toBe(50);

    const reset = await client.json<{ instance: { id: string; baseUrl: string; solved: boolean } }>(
      `/api/instances/${launch.body.instance.id}/reset`,
      { method: "POST" },
    );
    expect(reset.status).toBe(200);
    expect(reset.body.instance.id).not.toBe(launch.body.instance.id);
    expect(reset.body.instance.solved).toBe(false); // fresh instance, not yet re-exploited

    // The fresh instance is a real, independently working process.
    const freshJar = new CookieClient(reset.body.instance.baseUrl);
    const health = await freshJar.fetch("/healthz");
    expect(health.status).toBe(200);

    // XP earned earlier is not revoked by a reset.
    const xpAfterReset = (await client.json<{ xp: number }>("/api/progress")).body.xp;
    expect(xpAfterReset).toBe(50);

    await client.fetch(`/api/instances/${reset.body.instance.id}/stop`, { method: "POST" });
  });
});
