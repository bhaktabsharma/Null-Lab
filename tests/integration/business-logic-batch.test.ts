import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type CookieClient, type TestApp } from "./helpers.js";
import { expectSolvedOnce, formLogin, jsonPost, launch, type LabSession } from "./lab-harness.js";

/**
 * Business logic, payments and races (batch 12). Same shape as every lab test: ordinary use
 * does not solve; near-misses do not solve; the real exploit solves exactly once for XP and
 * its effect is shown in the application's own state; repeating it awards nothing more.
 * The two race labs only fall to genuinely overlapping requests, and the assertions are on
 * the resulting state, not on how many requests were sent.
 */
describe("business logic, payments and races (batch 12)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4221, labPortStart: 8100, labPortEnd: 8170 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  async function login(lab: LabSession, user: string, pass: string): Promise<CookieClient> {
    const b = lab.browser();
    await formLogin(b, user, pass);
    return b;
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // -------------------------------------------------------------------------
  it("sl-refund-idempotency-race: only OVERLAPPING refunds push the total above what was paid", async () => {
    const lab = await launch(t, "sl-refund-idempotency-race");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const refund = (order: string, amount: unknown, key?: string) => jsonPost(alice, `/api/orders/${order}/refund`, { amount }, "POST", key ? { "idempotency-key": key } : {});
    const orders = async () => (await alice.json<{ orders: { id: string; totalCents: number; refundedCents: number }[] }>("/api/orders")).body.orders;

    // validation and the sequential protections both work
    expect((await refund("o-1001", 10)).status).toBe(400); // no key
    expect((await refund("o-1001", 10, "short")).status).toBe(400);
    expect((await refund("o-1001", -5, "key-negative-01")).status).toBe(400);
    expect((await refund("o-9999", 10, "key-unknown-001")).status).toBe(404);
    expect((await refund("o-1001", 80.01, "key-toomuch-001")).status).toBe(409);
    expect((await refund("o-1001", 20, "key-legit-0001")).status).toBe(200);
    const replay = await refund("o-1001", 20, "key-legit-0001");
    expect(replay.body.replayed).toBe(true); // same key, one after the other: no second refund
    expect((await orders()).find((o) => o.id === "o-1001")!.refundedCents).toBe(2000);
    expect((await refund("o-1002", 5, "key-legit-0001")).status).toBe(409); // key belongs to another order
    expect((await refund("o-1001", 61, "key-seq-over-001")).status).toBe(409); // 60 left, one after the other
    expect(await lab.solved()).toBe(false);

    // the exploit: three refunds for $30 on a $45 order, all in flight together
    const batch = await Promise.all(["key-race-aaaa", "key-race-bbbb", "key-race-cccc"].map((k) => refund("o-1002", 30, k)));
    expect(batch.map((r) => r.status)).toEqual([200, 200, 200]);
    const after = (await orders()).find((o) => o.id === "o-1002")!;
    expect(after.refundedCents).toBe(9000);
    expect(after.refundedCents).toBeGreaterThan(after.totalCents); // refunded $90 on a $45 order

    // repeating: two overlapping refunds that share one idempotency key also both go through
    await expectSolvedOnce(lab, "hard", () => Promise.all([refund("o-1001", 50, "key-race-same1"), refund("o-1001", 50, "key-race-same1")]), xp0);
    await lab.stop();
  }, 40_000);

  // -------------------------------------------------------------------------
  it("sl-refund-ignores-discount: only refunding more than was paid solves it", async () => {
    const lab = await launch(t, "sl-refund-ignores-discount");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const ret = (order: string, lineId: string, qty: unknown) => jsonPost(alice, `/api/orders/${order}/returns`, { lineId, qty });

    expect((await ret("o-9999", "l1", 1)).status).toBe(404);
    expect((await ret("o-2002", "l9", 1)).status).toBe(404);
    expect((await ret("o-2002", "l1", 0)).status).toBe(400);
    expect((await ret("o-2002", "l1", 3)).status).toBe(409); // only 2 were bought
    // the order WITHOUT a coupon refunds exactly what was paid — fine
    expect((await ret("o-2002", "l1", 1)).body.refundCents).toBe(2500);
    expect((await ret("o-2002", "l1", 1)).body.order.refundedCents).toBe(5000);
    expect((await ret("o-2002", "l1", 1)).status).toBe(409); // nothing left to return
    expect(await lab.solved()).toBe(false);
    // the discounted order: a refund below what was paid is still fine
    expect((await ret("o-2001", "l2", 1)).body.order).toMatchObject({ refundedCents: 4000, paidCents: 5000 });
    expect(await lab.solved()).toBe(false);

    // the exploit: the coat is refunded at its $60 list price although the whole order cost $50
    const res = await ret("o-2001", "l1", 1);
    expect(res.status).toBe(200);
    expect(res.body.order.refundedCents).toBe(10000);
    expect(res.body.order.refundedCents).toBeGreaterThan(res.body.order.paidCents);

    await expectSolvedOnce(lab, "medium", () => ret("o-2001", "l1", 1), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("sl-refund-to-wallet-bola: only crediting your wallet from someone else's order solves it", async () => {
    const lab = await launch(t, "sl-refund-to-wallet-bola");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const dana = await login(lab, "dana", "Dana-Mercato!11");
    const refund = (c: CookieClient, id: string) => jsonPost(c, `/api/orders/${id}/refund-to-wallet`, {});
    const wallet = async (c: CookieClient) => (await c.json<{ balanceCents: number }>("/api/wallet")).body.balanceCents;

    expect((await refund(alice, "o-9999")).status).toBe(404);
    expect((await refund(alice, "o-3004")).status).toBe(409); // her own order, but still pending
    expect((await refund(alice, "o-3003")).body.balanceCents).toBe(3500); // ordinary use
    expect((await refund(alice, "o-3003")).status).toBe(409); // already refunded
    expect(await lab.solved()).toBe(false);

    // the exploit: dana's delivered order, refunded into alice's wallet
    const res = await refund(alice, "o-3001");
    expect(res.status).toBe(200);
    expect(await wallet(alice)).toBe(3500 + 24900);
    // dana is the one who lost out: her order is marked refunded and her wallet got nothing
    const danaOrders = await dana.json<{ orders: { id: string; status: string }[] }>("/api/orders");
    expect(danaOrders.body.orders.find((o) => o.id === "o-3001")!.status).toBe("refunded");
    expect(await wallet(dana)).toBe(1500);

    await expectSolvedOnce(lab, "medium", () => refund(alice, "o-3002"), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("sl-coupon-stacking-slots: only a combined discount above 30% solves it", async () => {
    const lab = await launch(t, "sl-coupon-stacking-slots");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const apply = (kind: "promo" | "loyalty", code: string) => jsonPost(alice, `/api/cart/${kind}`, { code });
    const checkout = () => jsonPost(alice, "/api/checkout", {});

    expect(((await alice.json<{ rewards: { code: string }[] }>("/api/rewards")).body.rewards[0]!).code).toBe("LOYAL20");
    expect((await apply("promo", "NOPE")).status).toBe(404);
    expect((await apply("promo", "PROMO25")).body.discountPct).toBe(25);
    expect((await apply("promo", "WELCOME10")).status).toBe(409); // one promo code at a time
    expect((await checkout()).body.order.discountPct).toBe(25);
    expect(await lab.solved()).toBe(false);
    // exactly at the limit is allowed: 10% + 20% = 30%
    await apply("promo", "WELCOME10");
    await apply("loyalty", "LOYAL20");
    expect((await apply("loyalty", "LOYAL20")).status).toBe(409);
    expect((await checkout()).body.order.discountPct).toBe(30);
    expect(await lab.solved()).toBe(false);

    // the exploit: the two slots do not know about each other
    await apply("promo", "PROMO25");
    await apply("loyalty", "LOYAL20");
    const order = (await checkout()).body.order;
    expect(order.discountPct).toBe(45);
    expect(order.totalCents).toBe(5500);

    await expectSolvedOnce(lab, "medium", async () => {
      await apply("promo", "PROMO25");
      await apply("loyalty", "LOYAL20");
      await checkout();
    }, xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("sl-coupon-per-account-reuse: only a second ACCOUNT redeeming the code solves it", async () => {
    const lab = await launch(t, "sl-coupon-per-account-reuse");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const redeem = (c: CookieClient, code = "NEWBIE5") => jsonPost(c, "/api/coupons/redeem", { code });

    expect((await redeem(alice, "WRONG")).status).toBe(404);
    expect((await redeem(alice, "newbie5")).body.balanceCents).toBe(500); // codes are case-insensitive
    expect((await redeem(alice)).status).toBe(409); // the per-account check works for repeats by the same account
    expect(await lab.solved()).toBe(false);

    // registration is open (with its own validation)
    expect((await jsonPost(lab.browser(), "/api/register", { username: "x", password: "hunter22" })).status).toBe(400);
    expect((await jsonPost(lab.browser(), "/api/register", { username: "valid_name", password: "123" })).status).toBe(400);
    expect((await jsonPost(lab.browser(), "/api/register", { username: "Alice", password: "hunter22" })).status).toBe(409);

    // the exploit: a second account redeems the same "one-time" code
    const mallory = lab.browser();
    expect((await jsonPost(mallory, "/api/register", { username: "mallory", password: "hunter22" })).status).toBe(200);
    expect((await redeem(mallory)).body.balanceCents).toBe(500);

    await expectSolvedOnce(lab, "easy", async () => {
      const third = lab.browser();
      await jsonPost(third, "/api/register", { username: "third", password: "hunter22" });
      await redeem(third);
    }, xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("sl-referral-reward-unpaid: only a reward kept for a never-paid friend solves it", async () => {
    const lab = await launch(t, "sl-referral-reward-unpaid");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const credit = async () => (await alice.json<{ creditCents: number }>("/api/me")).body.creditCents;
    const code = (await alice.json<{ refCode: string }>("/api/me")).body.refCode;
    const register = async (name: string, ref?: string) => {
      const c = lab.browser();
      const r = await jsonPost(c, "/api/register", { username: name, password: "hunter22", ref });
      return { c, status: r.status };
    };
    const order = (c: CookieClient) => jsonPost<{ order: { id: string } }>(c, "/api/orders", { title: "Paperback" });

    expect((await register("nobody1", "NOT-A-CODE")).status).toBe(404);
    // an honest referral: the friend orders and pays, and the reward is fine
    const friend = await register("friend1", code);
    expect(friend.status).toBe(200);
    expect(await credit()).toBe(0);
    const o1 = await order(friend.c);
    expect(await credit()).toBe(1000); // the reward arrives at ORDER CREATION, before any payment
    expect((await jsonPost(friend.c, `/api/orders/${o1.body.order.id}/pay`, {})).status).toBe(200);
    expect((await jsonPost(friend.c, `/api/orders/${o1.body.order.id}/pay`, {})).status).toBe(409);
    const o2 = await order(friend.c);
    expect(await credit()).toBe(1000); // only the first order rewards
    await jsonPost(friend.c, `/api/orders/${o2.body.order.id}/cancel`, {});
    expect(await lab.solved()).toBe(false); // this friend did pay for an order

    // the exploit: a friend who orders, cancels, and never pays
    const ghost = await register("friend2", code);
    const g1 = await order(ghost.c);
    expect(await credit()).toBe(2000);
    expect((await jsonPost(ghost.c, `/api/orders/${g1.body.order.id}/cancel`, {})).status).toBe(200);
    expect(await credit()).toBe(2000); // the reward is never taken back

    await expectSolvedOnce(lab, "medium", async () => {
      const again = await register("friend3", code);
      const o = await order(again.c);
      await jsonPost(again.c, `/api/orders/${o.body.order.id}/cancel`, {});
    }, xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("sl-subscription-cycle-entitlement: only Pro use billed as Basic solves it", async () => {
    const lab = await launch(t, "sl-subscription-cycle-entitlement");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const plan = (p: string) => jsonPost(alice, "/api/subscription/plan", { plan: p });
    const exp = (q: string) => jsonPost(alice, "/api/exports", { quality: q });
    const renew = () => jsonPost<{ invoice: { cents: number; periodBilledPlan: string } }>(alice, "/api/billing/advance", {});

    expect((await plan("enterprise")).status).toBe(400);
    expect((await exp("8k")).status).toBe(400);
    expect((await exp("4k")).status).toBe(403); // Basic cannot do 4K
    expect((await exp("standard")).status).toBe(200);
    // honest upgrade: used Pro features and is billed for Pro
    await plan("pro");
    expect((await exp("4k")).status).toBe(200);
    expect((await renew()).body.invoice.cents).toBe(3000);
    // honest downgrade without having used any Pro feature
    await plan("basic");
    expect((await renew()).body.invoice.cents).toBe(1000);
    expect(await lab.solved()).toBe(false);

    // the exploit: upgrade, use Pro, switch back before the renewal
    await plan("pro");
    expect((await exp("4k")).status).toBe(200);
    expect((await exp("4k")).status).toBe(200);
    await plan("basic");
    const invoice = (await renew()).body.invoice;
    expect(invoice).toEqual({ periodBilledPlan: "basic", cents: 1000 }); // two 4K exports, billed as Basic

    await expectSolvedOnce(lab, "hard", async () => {
      await plan("pro");
      await exp("4k");
      await plan("basic");
      await renew();
    }, xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("sl-payment-return-status-tamper: only a declined payment reported as paid solves it", async () => {
    const pay = async (c: CookieClient, card: string): Promise<string> => {
      const r = await c.fetch("/pay/t-501", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `card=${card}` });
      expect(r.status).toBe(302);
      return r.headers.get("location")!;
    };
    const statusOf = async (c: CookieClient) => /t-501<\/td><td>[^<]*<\/td><td>[^<]*<\/td><td>(\w+)/.exec(await (await c.fetch("/orders")).text())![1];

    // (a) the honest path: a successful card is reported paid, and that is not a vulnerability
    const honest = await launch(t, "sl-payment-return-status-tamper");
    const hx = await login(honest, "alice", "practice123");
    const okUrl = await pay(hx, "4242424242424242");
    expect(okUrl).toContain("status=paid");
    expect((await hx.fetch(okUrl)).status).toBe(302);
    expect(await statusOf(hx)).toBe("paid");
    expect((await hx.fetch(okUrl)).status).toBe(409); // already paid
    expect(await honest.solved()).toBe(false);
    await honest.stop();

    // (b) the declined path and the attack
    const lab = await launch(t, "sl-payment-return-status-tamper");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const declined = await pay(alice, "4000000000000002");
    expect(declined).toContain("status=declined");
    const u = new URL(declined, "http://x");
    const withParam = (k: string, v: string) => {
      const q = new URLSearchParams(u.search);
      q.set(k, v);
      return `${u.pathname}?${q.toString()}`;
    };
    // tampering with what the signature DOES cover is refused
    expect((await alice.fetch(withParam("amount", "100"))).status).toBe(400);
    expect((await alice.fetch(withParam("sig", "0".repeat(32)))).status).toBe(400);
    expect((await alice.fetch(withParam("order", "t-999"))).status).toBe(404);
    expect((await alice.fetch(withParam("status", "paid") + "x")).status).not.toBe(302); // a mangled link does not slip through
    // honestly following the decline leaves the order unpaid
    expect((await alice.fetch(declined)).status).toBe(302);
    expect(await statusOf(alice)).toBe("payment_failed");
    expect(await lab.solved()).toBe(false);

    // the exploit: the signature never covered `status`
    expect((await alice.fetch(withParam("status", "paid"))).status).toBe(302);
    expect(await statusOf(alice)).toBe("paid");

    await expectSolvedOnce(lab, "medium", () => alice.fetch(withParam("status", "paid")), xp0);
    await lab.stop();
  }, 40_000);

  // -------------------------------------------------------------------------
  it("sl-topup-confirmation-replay: only a replayed confirmation solves it", async () => {
    const lab = await launch(t, "sl-topup-confirmation-replay");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const balance = async () => (await alice.json<{ balanceCents: number }>("/api/wallet")).body.balanceCents;
    const start = async (amount: unknown) => jsonPost<{ txId: string; amountCents: number; token: string }>(alice, "/api/topups", { amount });
    const confirm = (b: unknown) => jsonPost<{ balanceCents: number }>(alice, "/api/topups/confirm", b);

    expect((await start(0)).status).toBe(400);
    expect((await start(501)).status).toBe(400);
    const tx = await start(10);
    const good = { txId: tx.body.txId, amountCents: tx.body.amountCents, token: tx.body.token };
    expect((await confirm({ ...good, token: "x".repeat(32) })).status).toBe(400);
    expect((await confirm({ ...good, amountCents: 99999 })).status).toBe(400);
    expect((await confirm({ ...good, txId: "tx-unknown" })).status).toBe(404);
    expect(await balance()).toBe(0);
    expect((await confirm(good)).body.balanceCents).toBe(1000); // ordinary use
    expect(await lab.solved()).toBe(false);

    // the exploit: send the same, still-valid confirmation again
    expect((await confirm(good)).body.balanceCents).toBe(2000);
    expect(await balance()).toBe(2000); // one $10 payment, $20 in the wallet

    await expectSolvedOnce(lab, "easy", () => confirm(good), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("sl-race-checkout-cart-mutation: only a cart change DURING checkout solves it", async () => {
    const lab = await launch(t, "sl-race-checkout-cart-mutation");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    type Order = { id: string; authorizedCents: number; itemsCents: number };
    const add = (sku: string, qty = 1) => jsonPost(alice, "/api/cart/items", { sku, qty });
    const checkout = () => jsonPost<{ order: Order }>(alice, "/api/checkout", {});

    expect((await add("nope")).status).toBe(404);
    expect((await add("tea-tin", 0)).status).toBe(400);
    // one after the other, what is paid is what is shipped
    await add("ceramic-pot");
    const first = (await checkout()).body.order;
    expect(first.itemsCents).toBe(first.authorizedCents);
    expect((await checkout()).status).toBe(409); // empty cart
    // adding AFTER checkout finished goes to the next cart, not into that order
    await add("tea-tin");
    expect(await lab.solved()).toBe(false);

    // the exploit: checkout is waiting on the card authorization when two items land in the cart
    const checkingOut = checkout();
    await sleep(120);
    await add("ceramic-pot");
    await add("espresso-beans");
    const order = (await checkingOut).body.order;
    expect(order.authorizedCents).toBe(1500); // the card was authorized for the tea tin only
    expect(order.itemsCents).toBe(1500 + 4500 + 2800); // ...but the order ships all three
    const orders = (await alice.json<{ orders: Order[] }>("/api/orders")).body.orders;
    expect(orders[orders.length - 1]!.itemsCents - orders[orders.length - 1]!.authorizedCents).toBe(7300);

    await expectSolvedOnce(lab, "advanced", async () => {
      await add("tea-tin");
      const p = checkout();
      await sleep(120);
      await add("ceramic-pot");
      await p;
    }, xp0);
    await lab.stop();
  }, 40_000);

  // -------------------------------------------------------------------------
  it("sl-transfer-partial-completion: only creating money through a refused transfer solves it", async () => {
    const lab = await launch(t, "sl-transfer-partial-completion");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const bob = await login(lab, "bob", "Bob-Sendwise!22");
    const send = (c: CookieClient, to: string, amount: unknown) => jsonPost(c, "/api/transfers", { to, amount });
    const bal = async (c: CookieClient) => (await c.json<{ balanceCents: number }>("/api/account")).body.balanceCents;

    // ordinary use keeps the total constant
    expect((await send(alice, "bob", 30)).body.balanceCents).toBe(7000);
    expect(await bal(bob)).toBe(5000);
    // near-misses that are refused BEFORE any credit
    expect((await send(alice, "nobody", 10)).status).toBe(404);
    expect((await send(alice, "alice", 10)).status).toBe(400);
    expect((await send(alice, "bob", -5)).status).toBe(400);
    expect((await send(alice, "bob", 0)).status).toBe(400);
    expect(await bal(bob)).toBe(5000);
    expect(await lab.solved()).toBe(false);

    // the exploit: more than the balance. The request fails — and the recipient is credited anyway
    const refused = await send(alice, "bob", 500);
    expect(refused.status).toBe(402);
    expect(await bal(alice)).toBe(7000); // the sender lost nothing
    expect(await bal(bob)).toBe(5000 + 50000); // the recipient gained $500
    // total money now: 7000 + 55000 + 5000 (carol) = 67000, from 17000

    await expectSolvedOnce(lab, "medium", () => send(alice, "carol", 400), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("sl-currency-rounding-arbitrage: only accumulated rounding gains solve it", async () => {
    const lab = await launch(t, "sl-currency-rounding-arbitrage");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    type W = { EUR: number; USD: number };
    const conv = (from: string, to: string, amount: unknown) => jsonPost<{ wallet: W }>(alice, "/api/convert", { from, to, amount });
    const wallet = async () => (await alice.json<W>("/api/wallet")).body;
    const valueUsd = (w: W) => Math.round((w.EUR * 110) / 100) + w.USD;

    expect((await conv("EUR", "EUR", 1)).status).toBe(400);
    expect((await conv("EUR", "GBP", 1)).status).toBe(400);
    expect((await conv("EUR", "USD", 0.001)).status).toBe(400);
    expect((await conv("EUR", "USD", 1000)).status).toBe(409);
    const start = valueUsd(await wallet());
    // one honest round trip gains about a cent and is nowhere near the target
    expect((await conv("EUR", "USD", 1)).body.wallet.USD).toBe(110);
    await conv("USD", "EUR", 1.1);
    expect(valueUsd(await wallet()) - start).toBeLessThan(5);
    expect(await lab.solved()).toBe(false);

    // the exploit: round-trip the smallest unit; each trip gains a little, rounded up each way
    for (let i = 0; i < 40; i++) {
      await conv("EUR", "USD", 0.01);
      await conv("USD", "EUR", 0.02);
    }
    expect(await lab.solved()).toBe(false); // 40 trips is not enough on its own
    for (let i = 0; i < 160 && valueUsd(await wallet()) - start < 200; i++) {
      await conv("EUR", "USD", 0.01);
      await conv("USD", "EUR", 0.02);
    }
    const gain = valueUsd(await wallet()) - start;
    expect(gain).toBeGreaterThanOrEqual(200); // at least $2.00 created from nothing but conversions

    await expectSolvedOnce(lab, "medium", async () => {
      await conv("EUR", "USD", 0.01);
      await conv("USD", "EUR", 0.02);
    }, xp0);
    await lab.stop();
  }, 90_000);

  // -------------------------------------------------------------------------
  it("sl-giftcard-self-transfer: only a transfer that creates money solves it", async () => {
    const lab = await launch(t, "sl-giftcard-self-transfer");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const move = (from: string, to: string, amount: unknown) => jsonPost<{ cards: { id: string; balanceCents: number }[] }>(alice, "/api/giftcards/transfer", { fromCard: from, toCard: to, amount });
    const mine = async () => (await alice.json<{ cards: { id: string; balanceCents: number }[] }>("/api/giftcards")).body.cards;
    const sum = (cards: { balanceCents: number }[]) => cards.reduce((n, c) => n + c.balanceCents, 0);

    expect((await move("g-200", "g-100", 5)).status).toBe(404); // not her card
    expect((await move("g-100", "g-999", 5)).status).toBe(404);
    expect((await move("g-100", "g-101", 5000.01)).status).toBe(409);
    expect((await move("g-100", "g-101", -5)).status).toBe(400);
    // ordinary use: moving between her own cards, and gifting to someone else's card
    expect(sum((await move("g-100", "g-101", 10)).body.cards)).toBe(5500);
    expect(sum((await move("g-101", "g-200", 5)).body.cards)).toBe(5000);
    expect(await lab.solved()).toBe(false);

    // the exploit: the source and destination are the same card
    const res = await move("g-100", "g-100", 40);
    expect(res.status).toBe(200);
    const cards = await mine();
    expect(cards.find((c) => c.id === "g-100")!.balanceCents).toBe(8000); // $40 was "moved" and the card doubled
    expect(sum(cards)).toBeGreaterThan(5500); // more than the $55 ever issued

    await expectSolvedOnce(lab, "medium", () => move("g-100", "g-100", 10), xp0);
    await lab.stop();
  }, 30_000);
});
