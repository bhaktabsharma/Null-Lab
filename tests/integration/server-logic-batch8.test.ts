import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CookieClient } from "./helpers.js";
import { startTestApp, type TestApp } from "./helpers.js";
import { expectSolvedOnce, formLogin, jsonPost, launch } from "./lab-harness.js";

const form = (c: CookieClient, path: string, fields: Record<string, string>) =>
  c.fetch(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const text = async (r: Response) => await r.text();

describe("server-logic batch 8", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4191, labPortStart: 7700, labPortEnd: 7760 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("sl-deserialization-trusted-types: importing real preference types never solves it; naming the internal type does", async () => {
    const lab = await launch(t, "sl-deserialization-trusted-types");
    const b = lab.browser();
    const xp0 = await lab.xp();
    await formLogin(b, "alice", "practice123");

    const normal = await jsonPost(b, "/settings/import", { payload: JSON.stringify({ __type: "ThemePreference", theme: "dark" }) });
    expect(normal.status).toBe(200);
    expect((await (await b.fetch("/settings")).text())).toContain("Admin: <span class=\"pill\">no");
    expect((await jsonPost(b, "/settings/import", { payload: JSON.stringify({ __type: "Nope" }) })).status).toBe(400);
    expect(await lab.solved()).toBe(false);

    const win = await jsonPost(b, "/settings/import", { payload: JSON.stringify({ __type: "AdminGrant" }) });
    expect(win.status).toBe(200);
    expect(await text(await b.fetch("/settings"))).toContain("Admin: <span class=\"pill\">yes");
    await expectSolvedOnce(lab, "hard", () => jsonPost(lab.browser(), "/settings/import", { payload: "{}" }), xp0); // already solved; repeat is a harmless no-op call
    await lab.stop();
  });

  it("sl-mass-assignment-profile: updating displayName/bio never solves it; adding role=admin does", async () => {
    const lab = await launch(t, "sl-mass-assignment-profile");
    const b = lab.browser();
    const xp0 = await lab.xp();
    await formLogin(b, "alice", "practice123");

    const normal = await b.json<{ role: string }>("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Alice C.", bio: "Hi!" }) });
    expect(normal.status).toBe(200);
    expect(normal.body.role).toBe("user");
    expect(await lab.solved()).toBe(false);

    const win = await b.json<{ role: string }>("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "admin" }) });
    expect(win.status).toBe(200);
    expect(win.body.role).toBe("admin");
    await expectSolvedOnce(lab, "easy", () => jsonPost(lab.browser(), "/login", { username: "none", password: "none" }), xp0); // solve is sticky; harmless unrelated call as repeat
    await lab.stop();
  });

  it("sl-price-negative-quantity: a normal order is fine; a negative quantity produces a non-positive total", async () => {
    const lab = await launch(t, "sl-price-negative-quantity");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await text(await form(b, "/order", { quantity: "2" }));
    expect(normal).toContain("$90.00");
    expect((await form(b, "/order", { quantity: "abc" })).status).toBe(400);
    expect(await lab.solved()).toBe(false);

    const exploit = await text(await form(b, "/order", { quantity: "-3" }));
    expect(exploit).toContain("$-135.00");
    await expectSolvedOnce(lab, "easy", () => form(lab.browser(), "/order", { quantity: "-1" }), xp0);
    await lab.stop();
  });

  it("sl-price-client-trusted: the real price is fine; a lower submitted price is accepted", async () => {
    const lab = await launch(t, "sl-price-client-trusted");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await form(b, "/checkout", { productId: "standing-desk", unitPriceUsd: "1200", quantity: "1" });
    expect(normal.status).toBe(200);
    expect(await lab.solved()).toBe(false);
    expect((await form(b, "/checkout", { productId: "standing-desk", unitPriceUsd: "-5", quantity: "1" })).status).toBe(400);

    const exploit = await text(await form(b, "/checkout", { productId: "standing-desk", unitPriceUsd: "1", quantity: "1" }));
    expect(exploit).toContain("$1.00 each");
    await expectSolvedOnce(lab, "medium", () => form(lab.browser(), "/checkout", { productId: "standing-desk", unitPriceUsd: "0.01", quantity: "1" }), xp0);
    await lab.stop();
  });

  it("sl-workflow-skip-payment: the full legitimate flow never solves it; skipping /pay and completing does", async () => {
    // Part A: full legitimate flow on its own instance.
    const legit = await launch(t, "sl-workflow-skip-payment");
    const a = legit.browser();
    const r1 = (await jsonPost(a, "/rides", {})).body as { ride: { id: number } };
    expect((await a.fetch(`/rides/${r1.ride.id}/accept`, { method: "POST" })).status).toBe(200);
    expect((await a.fetch(`/rides/${r1.ride.id}/pay`, { method: "POST" })).status).toBe(200);
    expect((await a.fetch(`/rides/${r1.ride.id}/complete`, { method: "POST" })).status).toBe(200);
    expect((await a.fetch(`/rides/${r1.ride.id}/complete`, { method: "POST" })).status).toBe(409); // never twice
    expect(await legit.solved()).toBe(false);
    await legit.stop();

    // Part B: the exploit on a fresh instance.
    const lab = await launch(t, "sl-workflow-skip-payment");
    const xp0 = await lab.xp();
    const b = lab.browser();
    const r2 = (await jsonPost(b, "/rides", {})).body as { ride: { id: number } };
    await b.fetch(`/rides/${r2.ride.id}/accept`, { method: "POST" });
    const complete = await b.json<{ ride: { status: string; paidAt: string | null } }>(`/rides/${r2.ride.id}/complete`, { method: "POST" });
    expect(complete.status).toBe(200);
    expect(complete.body.ride.status).toBe("completed");
    expect(complete.body.ride.paidAt).toBeNull();
    await expectSolvedOnce(lab, "medium", () => jsonPost(b, "/rides", {}), xp0); // solved already; repeat is a harmless unrelated call
    await lab.stop();
  });

  it("sl-race-coupon-reuse: a single redemption and a correctly-refused sequential retry never solve it; a real concurrent burst does", async () => {
    const lab = await launch(t, "sl-race-coupon-reuse");
    const b = lab.browser();
    const xp0 = await lab.xp();

    expect((await form(b, "/coupons/redeem", { code: "WELCOME10" })).status).toBe(200);
    expect((await form(b, "/coupons/redeem", { code: "WELCOME10" })).status).toBe(409); // sequential retry correctly refused
    expect(await lab.solved()).toBe(false);
    await lab.stop();

    const raced = await launch(t, "sl-race-coupon-reuse");
    const results = await Promise.all(Array.from({ length: 8 }, () => form(raced.browser(), "/coupons/redeem", { code: "WELCOME10" })));
    const successes = results.filter((r) => r.status === 200).length;
    expect(successes).toBeGreaterThan(1); // the race actually landed
    await expectSolvedOnce(raced, "hard", async () => undefined, xp0);
    await raced.stop();
  }, 30_000);

  it("sl-race-giftcard-overdraft: sequential withdrawals correctly respect the balance; a concurrent burst overdraws it", async () => {
    const lab = await launch(t, "sl-race-giftcard-overdraft");
    const b = lab.browser();
    const xp0 = await lab.xp();

    expect((await form(b, "/giftcard/withdraw", { amount: "20" })).status).toBe(200);
    expect((await form(b, "/giftcard/withdraw", { amount: "40" })).status).toBe(409); // correctly refused: only $30 left
    expect(await lab.solved()).toBe(false);
    await lab.stop();

    const raced = await launch(t, "sl-race-giftcard-overdraft");
    const rb = raced.browser();
    const results = await Promise.all(Array.from({ length: 6 }, () => form(rb, "/giftcard/withdraw", { amount: "20" })));
    const successCount = results.filter((r) => r.status === 200).length;
    expect(successCount * 20).toBeGreaterThan(50); // total withdrawn exceeds the $50 starting balance
    await expectSolvedOnce(raced, "hard", async () => undefined, xp0);
    await raced.stop();
  }, 30_000);

  it("sl-race-inventory-oversell: a sequential second order is correctly refused as out of stock; a concurrent burst oversells", async () => {
    const lab = await launch(t, "sl-race-inventory-oversell");
    const b = lab.browser();
    const xp0 = await lab.xp();

    expect((await b.fetch("/order", { method: "POST" })).status).toBe(200);
    expect((await b.fetch("/order", { method: "POST" })).status).toBe(409); // correctly refused: out of stock
    expect(await lab.solved()).toBe(false);
    await lab.stop();

    const raced = await launch(t, "sl-race-inventory-oversell");
    const rb = raced.browser();
    const results = await Promise.all(Array.from({ length: 8 }, () => rb.fetch("/order", { method: "POST" })));
    const successCount = results.filter((r) => r.status === 200).length;
    expect(successCount).toBeGreaterThan(1); // more than the 1 unit in stock
    await expectSolvedOnce(raced, "hard", async () => undefined, xp0);
    await raced.stop();
  }, 30_000);
});
