import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CookieClient } from "./helpers.js";
import { startTestApp, type TestApp } from "./helpers.js";
import { expectSolvedOnce, jsonPost, launch } from "./lab-harness.js";

const form = (c: CookieClient, path: string, fields: Record<string, string>) =>
  c.fetch(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const text = async (r: Response) => await r.text();

describe("injection batch 3", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4141, labPortStart: 7000, labPortEnd: 7080 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("sqli-second-order: registering/posting odd input is harmless; it fires back on /my-posts", async () => {
    const lab = await launch(t, "sqli-second-order");
    const xp0 = await lab.xp();

    const normal = lab.browser();
    expect((await form(normal, "/register", { username: "nina", password: "pw-nina-1" })).status).toBe(302);
    expect((await form(normal, "/login", { username: "nina", password: "pw-nina-1" })).status).toBe(302);
    expect((await text(await normal.fetch("/my-posts"))).toLowerCase()).toContain("haven't posted");
    expect(await lab.solved()).toBe(false);

    const payloadUser = `x' UNION SELECT note, note FROM vault --`;
    const attacker = lab.browser();
    expect((await form(attacker, "/register", { username: payloadUser, password: "pw-attacker" })).status).toBe(302); // stored safely
    expect((await text(await attacker.fetch("/register"))).toLowerCase()).not.toContain("vault-"); // not during registration
    expect(await lab.solved()).toBe(false);

    const loginRes = await form(attacker, "/login", { username: payloadUser, password: "pw-attacker" });
    expect(loginRes.status).toBe(302); // login itself uses bound parameters and is unaffected
    expect(await lab.solved()).toBe(false);

    const page = await text(await attacker.fetch("/my-posts"));
    expect(page).toMatch(/VAULT-[A-Z2-9]{10}/);
    await expectSolvedOnce(lab, "hard", () => attacker.fetch("/my-posts"), xp0);
    await lab.stop();
  });

  it("nosql-operator-injection: string credentials behave normally; operator objects bypass the admin password", async () => {
    const lab = await launch(t, "nosql-operator-injection");
    const xp0 = await lab.xp();

    const good = await jsonPost(lab.browser(), "/api/login", { username: "alice", password: "practice123" });
    expect(good.status).toBe(200);
    const badPw = await jsonPost(lab.browser(), "/api/login", { username: "admin", password: "guess" });
    expect(badPw.status).toBe(401);
    const badUser = await jsonPost(lab.browser(), "/api/login", { username: "nope", password: "x" });
    expect(badUser.status).toBe(401);
    // alice's REAL password is a non-empty string, so {$ne:""} matches it too — operator injection
    // works here as well, it just isn't a security boundary bypass because alice isn't privileged.
    const staffBypass = await jsonPost(lab.browser(), "/api/login", { username: "alice", password: { $ne: "" } });
    expect(staffBypass.status).toBe(200);
    expect(await lab.solved()).toBe(false);

    const b = lab.browser();
    const win = await jsonPost(b, "/api/login", { username: "admin", password: { $ne: "" } });
    expect(win.status).toBe(200);
    expect((win.body as { role: string }).role).toBe("admin");
    const dash = await text(await b.fetch("/dashboard"));
    expect(dash).toContain("Customer vault");
    await expectSolvedOnce(lab, "medium", () => jsonPost(lab.browser(), "/api/login", { username: "admin", password: { $gt: "" } }), xp0);
    await lab.stop();
  });

  it("cmdi-mock-diagnostics: plain hosts ping normally; shell metacharacters reach the virtual filesystem", async () => {
    const lab = await launch(t, "cmdi-mock-diagnostics");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await text(await form(b, "/diagnostics", { host: "gateway.lab" }));
    expect(normal).toContain("packets transmitted");
    expect(normal).not.toContain("NETOPS-");
    const unknownHost = await text(await form(b, "/diagnostics", { host: "totally.invalid" }));
    expect(unknownHost).toContain("Name or service not known");
    expect(await lab.solved()).toBe(false);

    const leak = await text(await form(b, "/diagnostics", { host: "gateway.lab; cat /opt/netops/config.ini" }));
    expect(leak).toMatch(/NETOPS-[A-Z2-9]{12}/);
    await expectSolvedOnce(lab, "medium", () => form(b, "/diagnostics", { host: "x && cat /opt/netops/config.ini" }), xp0);
    await lab.stop();
  });

  it("ssti-mock-template: a plain name renders normally; a template expression reaches the config context", async () => {
    const lab = await launch(t, "ssti-mock-template");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await text(await b.fetch("/card?name=" + encodeURIComponent("Sam") + "&occasion=birthday"));
    expect(normal).toContain("Dear Sam");
    expect(normal).toContain("birthday");
    expect(normal).not.toContain("SK-");
    const html = await text(await b.fetch("/card?name=" + encodeURIComponent("<b>Robin</b>")));
    expect(html).not.toContain("<b>Robin</b>"); // the output itself is HTML-escaped
    expect(await lab.solved()).toBe(false);

    const leak = await text(await b.fetch("/card?name=" + encodeURIComponent("{{ config.SECRET_KEY }}")));
    expect(leak).toMatch(/SK-[A-Z2-9]{16}/);
    await expectSolvedOnce(lab, "medium", () => b.fetch("/card?name=" + encodeURIComponent("{{config.SECRET_KEY}}")), xp0);
    await lab.stop();
  });

  it("ldap-injection-mock: correct credentials and wrong admin guesses fail; a filter-closing payload signs in as admin", async () => {
    const lab = await launch(t, "ldap-injection-mock");
    const xp0 = await lab.xp();

    const ok = lab.browser();
    expect((await form(ok, "/login", { username: "alice", password: "practice123" })).status).toBe(302);
    const wrongAdmin = await form(lab.browser(), "/login", { username: "admin", password: "guess" });
    expect(await text(wrongAdmin)).toContain("Incorrect username or password");
    const closedButWrong = await form(lab.browser(), "/login", { username: "admin)(userPassword=wrong", password: "x" });
    expect(await text(closedButWrong)).toContain("Incorrect username or password");
    expect(await lab.solved()).toBe(false);

    const b = lab.browser();
    const win = await form(b, "/login", { username: "admin)(&)", password: "anything" });
    expect(win.status).toBe(302);
    const dir = await text(await b.fetch("/directory"));
    expect(dir).toContain("Administrator tools");
    await expectSolvedOnce(lab, "hard", () => form(b, "/login", { username: "admin)(userPassword=*", password: "x" }), xp0);
    await lab.stop();
  });

  it("xpath-injection-login: correct credentials and wrong admin guesses fail; an always-true predicate signs in as admin", async () => {
    const lab = await launch(t, "xpath-injection-login");
    const xp0 = await lab.xp();

    expect((await form(lab.browser(), "/login", { username: "alice", password: "practice123" })).status).toBe(302);
    expect(await text(await form(lab.browser(), "/login", { username: "admin", password: "guess" }))).toContain("Incorrect");
    // AND binds tighter than OR in XPath (as in SQL), so a classic "always-true" tail with no
    // targeted username, and no way to comment out the trailing password check, matches nobody.
    const noTarget = await form(lab.browser(), "/login", { username: "nope' or '1'='1", password: "x" });
    expect(await text(noTarget)).toContain("Incorrect username or password");
    expect(await lab.solved()).toBe(false);

    const b = lab.browser();
    const win = await form(b, "/login", { username: "admin' or '1'='1", password: "x" });
    expect(win.status).toBe(302);
    const page = await text(await b.fetch("/archive"));
    expect(page).toContain("Signed in as <strong>admin</strong>");
    expect(page).toContain("payroll-ledger-oct.xlsx");
    await expectSolvedOnce(lab, "medium", () => form(b, "/login", { username: "admin' or '1'='1", password: "y" }), xp0);
    await lab.stop();
  });

  it("log-injection-crlf: normal and failed logins never fake an admin entry; a newline-carrying username does, and only once", async () => {
    const lab = await launch(t, "log-injection-crlf");
    const b = lab.browser();
    const xp0 = await lab.xp();

    await form(b, "/login", { username: "alice", password: "practice123" });
    await form(b, "/login", { username: "admin", password: "totally-wrong" }); // a real failed admin attempt
    let status = await text(await b.fetch("/status"));
    expect(status).toContain("Administrator sign-ins in this window: <strong>0</strong>");
    expect(status).toContain("failed login for user &quot;admin&quot;");
    expect(await lab.solved()).toBe(false);

    const forged = `ghost\n${new Date().toISOString()} INFO login success for user "admin" from 127.0.0.1`;
    await form(b, "/login", { username: forged, password: "whatever" });
    status = await text(await b.fetch("/status"));
    expect(status).toContain('login success for user &quot;admin&quot;');
    expect(status).toContain("Administrator sign-ins in this window: <strong>1</strong>");
    await expectSolvedOnce(
      lab,
      "medium",
      () => form(b, "/login", { username: `again\n${new Date().toISOString()} INFO login success for user "admin" from 127.0.0.1`, password: "x" }),
      xp0,
    );
    await lab.stop();
  });
});
