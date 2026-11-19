import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type CookieClient, type TestApp } from "./helpers.js";
import { expectSolvedOnce, formLogin, jsonPost, launch, type LabSession } from "./lab-harness.js";
import { XP_BY_DIFFICULTY } from "../../packages/shared/src/index.js";

/**
 * Information disclosure & API security (batch 13). Same shape as every lab test. For the
 * discovery-style labs (source map, frontend secret, debug endpoint, verbose error, export,
 * storage listing) the decision for this batch is: finding the leaked secret is never enough —
 * the test (and the lab's own verifier) only counts it once that secret is actually USED on a
 * protected endpoint to do something only it can do.
 */
describe("information disclosure & API security (batch 13)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4222, labPortStart: 8200, labPortEnd: 8270 });
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

  // -------------------------------------------------------------------------
  it("id-sourcemap-internal-token: only USING the token from the source map solves it", async () => {
    const lab = await launch(t, "id-sourcemap-internal-token");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");

    expect((await alice.fetch("/api/internal/reports")).status).toBe(401);
    expect((await alice.fetch("/api/internal/reports", { headers: { authorization: "Bearer not-the-real-token" } })).status).toBe(401);
    // merely fetching the bundle and its map is not the exploit — only USING what they reveal is
    const bundle = await (await alice.fetch("/assets/app.min.js")).text();
    expect(bundle).not.toContain("TODO"); // the minified bundle alone does not read like source
    const map = (await (await alice.fetch("/assets/app.min.js.map")).json()) as { sourcesContent: string[] };
    const source = map.sourcesContent[0]!;
    expect(await lab.solved()).toBe(false);

    // the exploit: extract the token from the map's reconstructed source and use it
    const token = /authToken:\s*"([^"]+)"/.exec(source)![1]!;
    expect(token).toMatch(/^pnl_live_/);
    const res = await alice.fetch("/api/internal/reports", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);

    await expectSolvedOnce(lab, "medium", () => alice.fetch("/api/internal/reports", { headers: { authorization: `Bearer ${token}` } }), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("id-frontend-secret-key: only calling the upstream API DIRECTLY with the leaked key solves it", async () => {
    const lab = await launch(t, "id-frontend-secret-key");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");

    // ordinary use: the app's own proxy, no key involved from the client's side
    expect((await alice.json<{ via: string }>("/api/geocode?q=paris")).body.via).toBe("server-proxy");
    expect(await lab.solved()).toBe(false);
    // the key alone, unused, is just a string sitting in a config file
    const config = await (await alice.fetch("/assets/config.js")).text();
    const key = /geocodeApiKey:\s*"([^"]+)"/.exec(config)![1]!;
    expect(await lab.solved()).toBe(false);

    expect((await alice.fetch(`/api/geocode-upstream?key=wrong-key`)).status).toBe(401);
    const res = await alice.fetch(`/api/geocode-upstream?key=${key}`);
    expect(res.status).toBe(200);
    expect((await res.json()).via).toBe("direct-upstream-call");

    await expectSolvedOnce(lab, "easy", () => alice.fetch(`/api/geocode-upstream?key=${key}`), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("id-debug-endpoint-signing-secret: only a notification SENT with the leaked secret solves it", async () => {
    const lab = await launch(t, "id-debug-endpoint-signing-secret");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const send = (to: string, message: string, signature: string) => jsonPost(alice, "/api/notifications/send", { to, message, signature });

    expect((await send("bob", "hi", "deadbeef")).status).toBe(401);
    expect((await alice.fetch("/debug/health")).status).toBe(200);
    // reading the debug endpoint is not itself the exploit
    const dbg = (await alice.json<{ signingSecret: string }>("/debug/signing-secret")).body;
    expect(await lab.solved()).toBe(false);

    const payload = JSON.stringify({ to: "bob", message: "release notes are ready" });
    const wrongSig = createHmac("sha256", "wrong-secret").update(payload).digest("hex");
    expect((await send("bob", "release notes are ready", wrongSig)).status).toBe(401);

    const sig = createHmac("sha256", dbg.signingSecret).update(payload).digest("hex");
    const res = await send("bob", "release notes are ready", sig);
    expect(res.status).toBe(200);

    await expectSolvedOnce(lab, "medium", () => {
      const p2 = JSON.stringify({ to: "carol", message: "again" });
      return send("carol", "again", createHmac("sha256", dbg.signingSecret).update(p2).digest("hex"));
    }, xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("id-verbose-error-service-token: only calling the internal service with the leaked token solves it", async () => {
    const lab = await launch(t, "id-verbose-error-service-token");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");

    expect((await alice.json("/api/track?tn=AB123456789")).body).toMatchObject({ status: "in_transit" });
    expect((await alice.fetch("/api/internal/routing/lookup")).status).toBe(401);
    expect(await lab.solved()).toBe(false);

    const bad = await alice.json<{ detail: string }>("/api/track?tn=not-a-tracking-number");
    expect(bad.status).toBe(502);
    const token = /Authorization: Bearer (\S+)/.exec(bad.body.detail)![1]!;
    expect(await lab.solved()).toBe(false); // the error alone is not the exploit

    expect((await alice.fetch("/api/internal/routing/lookup", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const res = await alice.fetch("/api/internal/routing/lookup", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);

    await expectSolvedOnce(lab, "medium", () => alice.fetch("/api/internal/routing/lookup", { headers: { authorization: `Bearer ${token}` } }), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("id-export-leaks-reset-tokens: only a password RESET using the leaked token solves it", async () => {
    const lab = await launch(t, "id-export-leaks-reset-tokens");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");

    // ordinary use: alice resets her OWN account with her own token, the way she would from an
    // emailed link — before any export has ever run, so this token was never exposed by it
    expect((await jsonPost(lab.browser(), "/api/password-reset", { username: "alice", token: "self-service-7f3a1c9d", newPassword: "newpass1" })).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    expect((await alice.fetch("/api/team/export")).status).toBe(200); // manager, so this alone is ordinary
    expect(await lab.solved()).toBe(false);
    const csv = await (await alice.fetch("/api/team/export")).text();
    const rows = csv.trim().split("\n").slice(1).map((r) => r.split(","));
    const ben = rows.find((r) => r[0] === "ben")!;
    expect(ben[4]).toMatch(/^[0-9a-f]+$/); // the reset token column is present in the export
    expect(rows.find((r) => r[0] === "carol")![4]).toBe(""); // carol has no pending reset
    expect((await jsonPost(lab.browser(), "/api/password-reset", { username: "ben", token: "wrong", newPassword: "hunter22" })).status).toBe(400);
    expect(await lab.solved()).toBe(false);

    // the exploit: reset ben's password using the token that only the export revealed
    const res = await jsonPost(lab.browser(), "/api/password-reset", { username: "ben", token: ben[4], newPassword: "takenover1" });
    expect(res.status).toBe(200);
    expect((await formLogin(lab.browser(), "ben", "takenover1")).status).toBe(302);

    // the token is now consumed: repeating the exact same reset must fail and must not award more XP
    expect(await lab.solved()).toBe(true);
    expect(await lab.xp()).toBe(xp0 + XP_BY_DIFFICULTY.medium);
    expect((await jsonPost(lab.browser(), "/api/password-reset", { username: "ben", token: ben[4], newPassword: "again12345" })).status).toBe(400);
    expect(await lab.xp()).toBe(xp0 + XP_BY_DIFFICULTY.medium);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("id-storage-bucket-listing: only fetching ANOTHER user's photo via the listing solves it", async () => {
    const lab = await launch(t, "id-storage-bucket-listing");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");

    const mine = await alice.json<{ photos: { key: string }[] }>("/api/photos");
    expect(mine.body.photos).toHaveLength(2);
    // fetching your OWN key, however you got it, is not the exploit
    expect((await alice.fetch(`/storage/${mine.body.photos[0]!.key}`)).status).toBe(200);
    expect(await lab.solved()).toBe(false);
    expect((await alice.fetch("/storage/not-a-real-key")).status).toBe(404);

    // merely listing the bucket is not the exploit either
    const listing = await alice.json<{ objects: { key: string }[] }>("/storage");
    expect(listing.body.objects.length).toBeGreaterThanOrEqual(4);
    expect(await lab.solved()).toBe(false);
    const foreignKey = listing.body.objects.map((o) => o.key).find((k) => !mine.body.photos.some((p) => p.key === k))!;

    const res = await alice.fetch(`/storage/${foreignKey}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dana");

    await expectSolvedOnce(lab, "medium", async () => {
      const remaining = listing.body.objects.map((o) => o.key).filter((k) => k !== foreignKey && !mine.body.photos.some((p) => p.key === k));
      await alice.fetch(`/storage/${remaining[0]}`);
    }, xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("api-webhook-signature-optional: only an UNSIGNED webhook granting Pro solves it", async () => {
    const lab = await launch(t, "api-webhook-signature-optional");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const webhook = (body: unknown, headers: Record<string, string>) => alice.fetch("/webhooks/billing", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    expect((await webhook({ type: "subscription.activated" }, { "x-webhook-signature": "deadbeef" })).status).toBe(401);
    expect((await webhook({}, {})).status).toBe(400);
    expect(await lab.solved()).toBe(false);
    // an unsigned event that does not activate anything reaches the same code path and must not solve
    expect((await webhook({ type: "invoice.paid" }, {})).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    // the exploit: NO signature header at all
    const res = await webhook({ type: "subscription.activated" }, {});
    expect(res.status).toBe(200);
    const html = await (await alice.fetch("/account")).text();
    expect(html).toContain("Your plan: pro");

    await expectSolvedOnce(lab, "medium", async () => {
      await webhook({ type: "subscription.cancelled" }, {}); // also unsigned — still accepted
      await webhook({ type: "subscription.activated" }, {});
    }, xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("api-key-scope-by-verb: only a DELETE with the read-only key solves it", async () => {
    const lab = await launch(t, "api-key-scope-by-verb");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const html = await (await alice.fetch("/developer")).text();
    const readKey = /inv_read_\w+/.exec(html)![0]!;
    const writeKey = /inv_write_\w+/.exec(html)![0]!;
    const asKey = (key: string) => (path: string, method = "GET") => alice.fetch(path, { method, headers: { authorization: `Bearer ${key}` } });

    expect((await asKey("nonsense")("/api/invoices")).status).toBe(401);
    expect((await asKey(readKey)("/api/invoices")).status).toBe(200);
    expect((await asKey(readKey)("/api/invoices/inv-1")).status).toBe(200);
    // the write-only action, done honestly with the FULL-access key, is not the exploit
    expect((await asKey(writeKey)("/api/invoices/inv-2", "DELETE")).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    // the exploit: DELETE on a single invoice, with the key documented as read-only
    const res = await asKey(readKey)("/api/invoices/inv-1", "DELETE");
    expect(res.status).toBe(200);
    expect((await asKey(writeKey)("/api/invoices")).status).toBe(200);

    await expectSolvedOnce(lab, "medium", () => asKey(readKey)("/api/invoices/inv-3", "DELETE"), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("gql-batching-rate-limit-bypass: only ONE request's batch exceeding the per-request op count, and finding the code, solves it", async () => {
    const lab = await launch(t, "gql-batching-rate-limit-bypass");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const q = (c: string) => ({ query: "query($c: String!) { checkRecoveryCode(code: $c) }", variables: { c } });
    const single = (code: string) => jsonPost<{ data?: { checkRecoveryCode: boolean } }>(alice, "/graphql", q(code));
    const batch = (codes: string[]) => jsonPost<{ data?: { checkRecoveryCode: boolean } }[]>(alice, "/graphql", codes.map(q));
    // The lockout counter only cares how many operations are inside ONE request, never whether any
    // of them happen to be correct — so every assertion below is safe regardless of the seeded code.

    // ordinary use: a couple of single guesses (request 1 of 5, request 2 of 5)
    await single("00");
    await single("01");
    expect(await lab.solved()).toBe(false);
    // a small batch, at the per-request op-count limit (5), is not the exploit either (request 3 of 5)
    const small = await batch(["02", "03", "04", "05", "06"]);
    expect(small.status).toBe(200);
    expect(await lab.solved()).toBe(false);

    // the exploit: one batch of every possible 2-digit code, well over the per-request limit (request 4 of 5)
    const allCodes = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, "0"));
    const res = await batch(allCodes);
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.data?.checkRecoveryCode === true)).toBe(true);
    expect(await lab.solved()).toBe(true);
    expect(await lab.xp()).toBe(xp0 + 200); // hard

    // repeating (request 5 of 5) still finds the code but must not award XP a second time
    const again = await batch(allCodes);
    expect(again.status).toBe(200);
    expect(await lab.xp()).toBe(xp0 + 200);
  }, 30_000);

  // -------------------------------------------------------------------------
  it("gql-alias-cost-abuse: only an operation that really EXECUTES the field >3 times solves it", async () => {
    const lab = await launch(t, "gql-alias-cost-abuse");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const gql = (query: string) => jsonPost<{ data?: Record<string, { priceCents: number }> }>(alice, "/graphql", { query });

    expect((await gql(`{ freeQuote(symbol: "ACME") { priceCents } }`)).body.data).toBeTruthy();
    expect((await gql(`{ a: premiumQuote(symbol: "ACME") { priceCents } b: premiumQuote(symbol: "ACME") { priceCents } c: premiumQuote(symbol: "ACME") { priceCents } }`)).status).toBe(200); // exactly at the limit
    expect(await lab.solved()).toBe(false);
    expect((await gql(`{ a: premiumQuote(symbol: "ACME") { priceCents } b: freeQuote(symbol: "ACME") { priceCents } }`)).status).toBe(200); // a different field name does not count toward the premium total
    expect(await lab.solved()).toBe(false);

    // the exploit: the SAME field, aliased 5 times in one operation
    const query = `{ q1: premiumQuote(symbol: "A") { priceCents } q2: premiumQuote(symbol: "B") { priceCents } q3: premiumQuote(symbol: "C") { priceCents } q4: premiumQuote(symbol: "D") { priceCents } q5: premiumQuote(symbol: "E") { priceCents } }`;
    const res = await gql(query);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data!)).toHaveLength(5);

    await expectSolvedOnce(lab, "hard", () => gql(`{ x1: premiumQuote(symbol: "X") { priceCents } x2: premiumQuote(symbol: "Y") { priceCents } x3: premiumQuote(symbol: "Z") { priceCents } x4: premiumQuote(symbol: "W") { priceCents } }`), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("api-content-type-validation-bypass: only a non-JSON request setting role=admin solves it", async () => {
    const lab = await launch(t, "api-content-type-validation-bypass");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const patchJson = (body: unknown) => jsonPost(alice, "/api/profile", body, "PATCH");
    const patchText = (text: string) => alice.fetch("/api/profile", { method: "PATCH", headers: { "content-type": "text/plain" }, body: text });

    expect((await patchJson({ displayName: "Alice C." })).body).toMatchObject({ profile: { displayName: "Alice C.", role: "user" } });
    expect((await patchJson({ role: "admin" })).body.profile.role).toBe("user"); // the JSON path ignores an unknown field entirely
    expect((await patchJson({ bio: "x".repeat(400) })).status).toBe(400);
    expect(await lab.solved()).toBe(false);
    // the legacy path honestly updating the allowed-sounding fields is not the exploit
    expect((await patchText(JSON.stringify({ displayName: "Legacy Alice" }))).status).toBe(200);
    expect(await lab.solved()).toBe(false);
    expect((await patchText("not json")).status).toBe(400);

    // the exploit: the same path, asking for role too
    const res = await patchText(JSON.stringify({ role: "admin" }));
    expect(res.status).toBe(200);
    const check = await (await alice.fetch("/profile")).text();
    expect(check).toContain("Role: admin");

    await expectSolvedOnce(lab, "medium", () => patchText(JSON.stringify({ role: "admin", bio: "still admin" })), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("api-batch-endpoint-authz-skip: only a batch touching ANOTHER user's ticket solves it", async () => {
    const lab = await launch(t, "api-batch-endpoint-authz-skip");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const dana = await login(lab, "dana", "Dana-Deskline!81");
    const batchUpdate = (ids: string[], status: string) => jsonPost<{ updated: string[] }>(alice, "/api/tickets/batch-update", { ids, status });

    expect((await jsonPost(alice, "/api/tickets/t-3", { status: "closed" }, "PATCH")).status).toBe(403); // the single endpoint is correctly scoped
    expect((await batchUpdate([], "closed")).status).toBe(400);
    expect((await batchUpdate(["t-1", "t-2"], "wat")).status).toBe(400);
    // an honest batch over her own tickets is not the exploit
    expect((await batchUpdate(["t-1", "t-2"], "closed")).body.updated).toEqual(["t-1", "t-2"]);
    expect(await lab.solved()).toBe(false);

    // the exploit: dana's ticket is included in alice's batch
    const res = await batchUpdate(["t-1", "t-3"], "open");
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(["t-1", "t-3"]);
    const danaView = await dana.json<{ tickets: { id: string; status: string }[] }>("/api/tickets");
    expect(danaView.body.tickets.find((x) => x.id === "t-3")!.status).toBe("open");

    await expectSolvedOnce(lab, "medium", () => batchUpdate(["t-3"], "closed"), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("ws-message-level-authz: only a read_history for an UNAUTHORIZED room solves it", async () => {
    const { WebSocket } = await import("ws");
    const { wsConnectOptions } = await import("./proxy.js");
    const lab = await launch(t, "ws-message-level-authz");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const cookie = `roomcast_session_${lab.port}=${alice.getCookie(`roomcast_session_${lab.port}`)}`;

    const connect = async (room: string) => {
      // The WS handshake completes (and the client's "open" fires) before the route handler's
      // own room-membership check runs, so an unauthorized connection still briefly "opens" before
      // the server closes it. Wait a moment after open to let that close land, if it is coming.
      const extra = await wsConnectOptions(lab.port);
      return new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${lab.port}/connect?room=${room}`, { headers: { cookie }, ...extra });
        let settled = false;
        ws.on("close", (code) => {
          if (!settled) {
            settled = true;
            reject(new Error(`closed ${code}`));
          }
        });
        ws.on("error", (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
        ws.on("open", () => {
          setTimeout(() => {
            if (!settled) {
              settled = true;
              resolve(ws);
            }
          }, 200);
        });
      });
    };
    const ask = (ws: InstanceType<typeof WebSocket>, msg: unknown) =>
      new Promise<any>((resolve) => {
        ws.once("message", (m: Buffer) => resolve(JSON.parse(m.toString())));
        ws.send(JSON.stringify(msg));
      });

    await expect(connect("finance-leads")).rejects.toThrow(); // alice is not a member — refused at connect, correctly
    const ws = await connect("general");
    // ordinary use: history for the room the connection is actually authorized for
    const own = await ask(ws, { type: "read_history", room: "general" });
    expect(own.history).toContain("alice: good morning");
    expect(await lab.solved()).toBe(false);
    // not naming a room at all defaults to the connection's own authorized room — also fine
    const implicit = await ask(ws, { type: "read_history" });
    expect(implicit.room).toBe("general");
    expect(await lab.solved()).toBe(false);
    const posted = await ask(ws, { type: "post", text: "see you at 5" });
    expect(posted.posted).toBe(true);

    // the exploit: the SAME connection, authorized only for "general", asks for "finance-leads"
    const leak = await ask(ws, { type: "read_history", room: "finance-leads" });
    expect(leak.room).toBe("finance-leads");
    expect(leak.history.join(" ")).toContain("Q3 numbers");

    const xpAfter = await lab.xp();
    expect(xpAfter).toBe(xp0 + 200); // hard
    await ask(ws, { type: "read_history", room: "finance-leads" }); // repeat: no further XP
    expect(await lab.xp()).toBe(xpAfter);
    ws.close();
    await lab.stop();
  }, 30_000);
});
