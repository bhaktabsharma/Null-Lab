import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, CookieClient, waitFor, type TestApp } from "./helpers.js";

describe("auth flows", () => {
  let testApp: TestApp;
  beforeAll(async () => {
    testApp = await startTestApp({ apiPort: 4110, labPortStart: 6350, labPortEnd: 6360 });
  });
  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("guest login works with no credentials and /me reflects it", async () => {
    const client = new CookieClient(testApp.baseUrl);
    const guest = await client.json<{ user: { isGuest: boolean; username: string } }>("/api/auth/guest", { method: "POST" });
    expect(guest.status).toBe(200);
    expect(guest.body.user.isGuest).toBe(true);

    const me = await client.json<{ user: { isGuest: boolean } }>("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.isGuest).toBe(true);
  });

  it("registers a named account, rejects a duplicate username, and enforces password length", async () => {
    const client = new CookieClient(testApp.baseUrl);
    const ok = await client.json("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "dana_test", password: "practice123" }),
    });
    expect(ok.status).toBe(200);

    const dupe = new CookieClient(testApp.baseUrl);
    const dupeRes = await dupe.json("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "dana_test", password: "anotherpassword" }),
    });
    expect(dupeRes.status).toBe(409);

    const shortPw = new CookieClient(testApp.baseUrl);
    const shortRes = await shortPw.json("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "someone_else", password: "short" }),
    });
    expect(shortRes.status).toBe(400);
  });

  it("logs in with correct credentials, rejects wrong ones, and logout clears the session", async () => {
    const setup = new CookieClient(testApp.baseUrl);
    await setup.json("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "login_test_user", password: "correct-password" }),
    });

    const wrong = new CookieClient(testApp.baseUrl);
    const wrongRes = await wrong.json("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "login_test_user", password: "wrong-password" }),
    });
    expect(wrongRes.status).toBe(401);

    const right = new CookieClient(testApp.baseUrl);
    const rightRes = await right.json<{ user: { username: string } }>("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "login_test_user", password: "correct-password" }),
    });
    expect(rightRes.status).toBe(200);
    expect(rightRes.body.user.username).toBe("login_test_user");

    const beforeLogout = await right.fetch("/api/auth/me");
    expect(beforeLogout.status).toBe(200);
    await right.fetch("/api/auth/logout", { method: "POST" });
    const afterLogout = await right.fetch("/api/auth/me");
    expect(afterLogout.status).toBe(401);
  });

  it("unauthenticated requests to protected routes are rejected", async () => {
    const res = await fetch(`${testApp.baseUrl}/api/labs`);
    expect(res.status).toBe(401);
  });
});

describe("instance expiry sweep", () => {
  let testApp: TestApp;
  beforeAll(async () => {
    // Idle timeout of ~0.02 minutes (~1.2s) so the sweep has something to catch quickly.
    testApp = await startTestApp({
      apiPort: 4111,
      labPortStart: 6361,
      labPortEnd: 6370,
      envOverrides: { LAB_INSTANCE_IDLE_MINUTES: 0.02, LAB_INSTANCE_MAX_MINUTES: 60 },
    });
  });
  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("auto-stops an instance that has been idle past LAB_INSTANCE_IDLE_MINUTES", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; status: string } }>("/api/labs/idor-invoice-leak/instances", {
      method: "POST",
    });
    expect(launch.body.instance.status).toBe("running");

    await waitFor(2000); // past the 1.2s idle threshold, with margin
    const stoppedCount = await testApp.manager.sweepExpired();
    expect(stoppedCount).toBeGreaterThanOrEqual(1);

    const after = await client.json<{ instance: { status: string } }>(`/api/instances/${launch.body.instance.id}`);
    expect(after.body.instance.status).toBe("expired");
  });
});

describe("sqli-login-bypass: reset genuinely wipes the per-instance SQLite file", () => {
  let testApp: TestApp;
  beforeAll(async () => {
    testApp = await startTestApp({ apiPort: 4112, labPortStart: 6371, labPortEnd: 6380 });
  });
  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("the old instance's db file is deleted and a fresh one is created on reset", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/sqli-login-bypass/instances", {
      method: "POST",
    });

    const firstRow = testApp.manager.getForUser((await client.json<{ user: { id: string } }>("/api/auth/me")).body.user.id, launch.body.instance.id);
    expect(firstRow?.db_path).toBeTruthy();
    expect(fs.existsSync(firstRow!.db_path!)).toBe(true);

    const reset = await client.json<{ instance: { id: string; baseUrl: string } }>(`/api/instances/${launch.body.instance.id}/reset`, {
      method: "POST",
    });
    expect(reset.status).toBe(200);
    expect(reset.body.instance.id).not.toBe(launch.body.instance.id);

    // The old instance's own SQLite file is gone — a genuine reset, not a reused file.
    expect(fs.existsSync(firstRow!.db_path!)).toBe(false);

    // The new instance is healthy and has its own fresh db file.
    const me = await client.json<{ user: { id: string } }>("/api/auth/me");
    const secondRow = testApp.manager.getForUser(me.body.user.id, reset.body.instance.id);
    expect(secondRow?.db_path).toBeTruthy();
    expect(secondRow!.db_path).not.toBe(firstRow!.db_path);
    expect(fs.existsSync(secondRow!.db_path!)).toBe(true);

    await client.fetch(`/api/instances/${reset.body.instance.id}/stop`, { method: "POST" });
  });
});
