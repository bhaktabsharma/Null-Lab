import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./helpers.js";
import { expectSolvedOnce, formLogin, jsonPost, launch, newLearner } from "./lab-harness.js";

/**
 * Batch 1: access-control labs. Every lab test follows the same shape:
 *   1. ordinary, non-exploit use works and does NOT solve the lab;
 *   2. near-miss / negative attempts do NOT solve it;
 *   3. the intended exploit solves it, server-side, exactly once for XP;
 *   4. repeating the exploit does not award XP again.
 */
describe("access-control batch 1", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4130, labPortStart: 6700, labPortEnd: 6760 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("ac-forced-browsing: robots.txt reveals the path; only the restricted resource itself solves", async () => {
    const lab = await launch(t, "ac-forced-browsing");
    const b = lab.browser();
    const xp0 = await lab.xp();
    const EXPORT = "/staff-tools-4821/payroll-export";

    expect((await b.fetch("/")).status).toBe(200);
    expect(await (await b.fetch("/robots.txt")).text()).toContain("Disallow: /staff-tools-4821/");
    expect((await b.fetch("/staff-tools-4821/")).status).toBe(200); // finding the index proves nothing
    expect((await b.fetch("/staff-tools-4821/nope")).status).toBe(404);
    expect(await lab.solved()).toBe(false);

    const admin = lab.browser(); // an actual administrator reading it is not a vulnerability
    await formLogin(admin, "ops-admin", "Adm1n-Only!2024");
    expect((await admin.fetch(EXPORT)).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    const res = await b.fetch(EXPORT);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("employee,department,monthly_gross");
    await expectSolvedOnce(lab, "beginner", () => b.fetch(EXPORT), xp0);
    await lab.stop();
  });

  it("ac-vertical-role-cookie: only a forged role cookie on a non-admin session solves", async () => {
    const lab = await launch(t, "ac-vertical-role-cookie");
    const role = `role_${lab.port}`;
    const xp0 = await lab.xp();

    const b = lab.browser();
    await formLogin(b, "alice", "practice123");
    expect(b.getCookie(role)).toBe("user");
    expect((await b.fetch("/dashboard")).status).toBe(200);
    expect((await b.fetch("/admin/customers")).status).toBe(403);

    const admin = lab.browser();
    await formLogin(admin, "ops", "Adm1n-CRM!77");
    expect(admin.getCookie(role)).toBe("admin");
    expect((await admin.fetch("/admin/customers")).status).toBe(200);

    const anon = lab.browser(); // a forged cookie with no login is not served
    anon.setCookie(role, "admin");
    expect((await anon.fetch("/admin/customers")).status).toBe(302);
    expect(await lab.solved()).toBe(false);

    b.setCookie(role, "admin");
    const res = await b.fetch("/admin/customers");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Customer export");
    await expectSolvedOnce(lab, "beginner", () => b.fetch("/admin/customers"), xp0);
    await lab.stop();
  });

  it("ac-horizontal-uid-cookie: own id, unknown id do not solve; another member's id does", async () => {
    const lab = await launch(t, "ac-horizontal-uid-cookie");
    const member = `member_${lab.port}`;
    const xp0 = await lab.xp();

    const b = lab.browser();
    await formLogin(b, "alice", "practice123");
    expect(b.getCookie(member)).toBe("1001");
    const own = await (await b.fetch("/me/workouts")).text();
    expect(own).toContain("Alice Chen");
    expect(own).not.toContain("Rehab block");

    b.setCookie(member, "9999");
    expect((await b.fetch("/me/workouts")).status).toBe(404);
    b.setCookie(member, "1001");
    expect((await b.fetch("/me/workouts")).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    b.setCookie(member, "1002");
    const stolen = await (await b.fetch("/me/workouts")).text();
    expect(stolen).toContain("Bob Okafor");
    expect(stolen).toContain("Rehab block");
    await expectSolvedOnce(lab, "easy", () => b.fetch("/me/workouts"), xp0);
    await lab.stop();
  });

  it("ac-bfla-remove-member: the client script exposes the endpoint; a non-admin removal solves once", async () => {
    const lab = await launch(t, "ac-bfla-remove-member");
    const xp0 = await lab.xp();

    const b = lab.browser();
    expect((await b.fetch("/api/members/4/remove", { method: "POST" })).status).toBe(401);
    await formLogin(b, "alice", "practice123");
    const page = await (await b.fetch("/team")).text();
    expect(page).toContain("/api/members/"); // shipped to every user, admin or not
    expect(page).toContain("remove");
    expect((await b.json<{ members: unknown[] }>("/api/members")).body.members).toHaveLength(5);
    expect((await b.fetch("/api/members/99/remove", { method: "POST" })).status).toBe(404);
    expect(await lab.solved()).toBe(false);

    const admin = lab.browser(); // a genuine admin removing someone is fine
    await formLogin(admin, "tess", "Adm1n-Team!42");
    expect((await admin.fetch("/api/members/5/remove", { method: "POST" })).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    const res = await b.json<{ removed: { id: number } }>("/api/members/4/remove", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.body.removed.id).toBe(4);
    await expectSolvedOnce(lab, "easy", () => b.fetch("/api/members/4/remove", { method: "POST" }), xp0);
    expect((await b.json<{ members: unknown[] }>("/api/members")).body.members).toHaveLength(3);
    await lab.stop();
  });

  it("ac-method-switch: GET is refused, POST/PUT leak the log to a non-admin", async () => {
    const lab = await launch(t, "ac-method-switch");
    const xp0 = await lab.xp();

    const b = lab.browser();
    expect((await b.fetch("/api/admin/audit-log", { method: "POST" })).status).toBe(401); // login still required
    await formLogin(b, "alice", "practice123");
    expect(await (await b.fetch("/api/docs")).text()).toContain("GET, POST, PUT");
    expect((await b.fetch("/api/admin/audit-log")).status).toBe(403);
    expect(await lab.solved()).toBe(false);

    const admin = lab.browser();
    await formLogin(admin, "ada", "Adm1n-Audit!9");
    const legit = await admin.json<{ entries: unknown[] }>("/api/admin/audit-log");
    expect(legit.status).toBe(200);
    expect(legit.body.entries).toHaveLength(6);
    expect(await lab.solved()).toBe(false);

    const res = await jsonPost(b, "/api/admin/audit-log", {});
    expect(res.status).toBe(200);
    expect((res.body as { entries: unknown[] }).entries).toHaveLength(6);
    await expectSolvedOnce(lab, "medium", () => jsonPost(b, "/api/admin/audit-log", { actor: "ada" }, "PUT"), xp0);
    const filtered = await jsonPost(b, "/api/admin/audit-log", { actor: "ada" }, "PUT");
    expect((filtered.body as { entries: unknown[] }).entries).toHaveLength(4);
    await lab.stop();
  });

  it("ac-uuid-leak: guessing fails and own notes don't solve; a leaked id does; ids differ per instance", async () => {
    const lab = await launch(t, "ac-uuid-leak");
    const xp0 = await lab.xp();
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    const b = lab.browser();
    expect((await b.fetch("/api/notes")).status).toBe(401);
    await formLogin(b, "alice", "practice123");
    const mine = (await b.json<{ notes: { id: string; title: string }[] }>("/api/notes")).body.notes;
    expect(mine).toHaveLength(2);
    expect(mine.every((n) => UUID.test(n.id))).toBe(true);
    expect((await b.json(`/api/notes/${mine[0]!.id}`)).status).toBe(200); // own note

    expect((await b.fetch("/api/notes/00000000-0000-4000-8000-000000000000")).status).toBe(404); // guessing
    const feed = (await lab.browser().json<{ events: { who: string; action: string; noteId: string }[] }>("/api/activity")).body.events; // public
    expect(feed).toHaveLength(4);
    expect(await lab.solved()).toBe(false); // reading the feed is not the exploit

    const bobId = feed.find((e) => e.who === "bob" && e.action === "edited a note")!.noteId;
    const res = await b.json<{ note: { owner: string; title: string } }>(`/api/notes/${bobId}`);
    expect(res.status).toBe(200);
    expect(res.body.note.owner).toBe("bob");
    expect(res.body.note.title).toBe("Landlord call");
    await expectSolvedOnce(lab, "medium", () => b.fetch(`/api/notes/${bobId}`), xp0);

    // Ids are derived from the instance token: a second instance has different ones.
    const other = await launch(t, "ac-uuid-leak");
    const otherFeed = (await other.browser().json<{ events: { noteId: string }[] }>("/api/activity")).body.events;
    expect(otherFeed.map((e) => e.noteId)).not.toContain(bobId);
    await other.stop();
    await lab.stop();
  });

  it("ac-nested-object: own tasks and foreign projects are handled correctly; the mismatched pair leaks", async () => {
    const lab = await launch(t, "ac-nested-object");
    const xp0 = await lab.xp();

    const b = lab.browser();
    await formLogin(b, "alice", "practice123");
    const projects = (await b.json<{ projects: { id: number }[] }>("/api/projects")).body.projects;
    expect(projects.map((p) => p.id)).toEqual([1]);
    expect((await b.fetch("/api/projects/1/tasks/11")).status).toBe(200);
    expect((await b.fetch("/api/projects/2/tasks/21")).status).toBe(403); // parent check works
    expect((await b.fetch("/api/projects/2/tasks")).status).toBe(403);
    expect((await b.fetch("/api/projects/1/tasks/9999")).status).toBe(404);
    expect(await lab.solved()).toBe(false);

    const res = await b.json<{ task: { id: number; detail: string } }>("/api/projects/1/tasks/22");
    expect(res.status).toBe(200);
    expect(res.body.task.detail).toContain("Offer price");
    await expectSolvedOnce(lab, "medium", () => b.fetch("/api/projects/1/tasks/22"), xp0);
    await lab.stop();
  });

  it("ac-bulk-endpoint: single fetch is protected, own batch is fine, a foreign batch solves", async () => {
    const lab = await launch(t, "ac-bulk-endpoint");
    const xp0 = await lab.xp();

    const b = lab.browser();
    await formLogin(b, "alice", "practice123");
    expect((await b.fetch("/api/messages/4")).status).toBe(403);
    expect((await b.json<{ messages: { id: number }[] }>("/api/messages")).body.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    expect((await jsonPost(b, "/api/messages/batch", { ids: [1, 2] })).status).toBe(200);
    expect((await jsonPost(b, "/api/messages/batch", { ids: [] })).status).toBe(400);
    expect((await jsonPost(b, "/api/messages/batch", { ids: Array.from({ length: 21 }, (_, i) => i + 1) })).status).toBe(400);
    expect((await jsonPost(b, "/api/messages/batch", { ids: [999] })).status).toBe(200); // nothing found, nothing leaked
    expect(await lab.solved()).toBe(false);

    const res = await jsonPost(b, "/api/messages/batch", { ids: [1, 4, 6] });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("S3curestaging");
    await expectSolvedOnce(lab, "medium", () => jsonPost(b, "/api/messages/batch", { ids: [4] }), xp0);
    await lab.stop();
  });

  it("ac-bopla-fields: default shape hides pay data; HR may see it; ?fields= leaks it to an employee", async () => {
    const lab = await launch(t, "ac-bopla-fields");
    const xp0 = await lab.xp();

    const b = lab.browser();
    await formLogin(b, "alice", "practice123");
    const dflt = (await b.json<{ employee: Record<string, unknown> }>("/api/employees/2")).body.employee;
    expect(dflt.name).toBe("Marcus Webb");
    expect(dflt).not.toHaveProperty("salary");
    expect(dflt).not.toHaveProperty("performanceRating");
    const list = (await b.json<{ employees: Record<string, unknown>[] }>("/api/employees")).body.employees;
    expect(list.every((e) => !("salary" in e))).toBe(true);
    const harmless = (await b.json<{ employee: Record<string, unknown> }>("/api/employees/2?fields=name,title")).body.employee;
    expect(Object.keys(harmless).sort()).toEqual(["name", "title"]);
    expect(await lab.solved()).toBe(false);

    const hr = lab.browser(); // HR legitimately sees salary
    await formLogin(hr, "hana", "Adm1n-HR!31");
    expect((await hr.json<{ employee: { salary: number } }>("/api/employees/2")).body.employee.salary).toBe(148000);
    expect(await lab.solved()).toBe(false);

    const leaked = (await b.json<{ employee: { salary: number } }>("/api/employees/2?fields=id,name,salary")).body.employee;
    expect(leaked.salary).toBe(148000);
    await expectSolvedOnce(lab, "medium", () => b.fetch("/api/employees/3?fields=performanceRating"), xp0);
    await lab.stop();
  });

  it("ac-tenant-header: own tenant is fine; naming another tenant in X-Tenant-Id leaks its tickets", async () => {
    const lab = await launch(t, "ac-tenant-header");
    const xp0 = await lab.xp();

    const b = lab.browser();
    await formLogin(b, "alice", "practice123");
    const own = await b.fetch("/api/tickets");
    expect(own.headers.get("x-tenant-id")).toBe("acme");
    expect(((await own.json()) as { tickets: unknown[] }).tickets).toHaveLength(2);
    expect((await b.fetch("/api/tickets", { headers: { "x-tenant-id": "acme" } })).status).toBe(200);
    expect((await b.fetch("/api/tickets", { headers: { "x-tenant-id": "nonexistent" } })).status).toBe(404);
    expect((await b.fetch("/api/tickets/201")).status).toBe(404); // not visible from your own tenant
    expect(await lab.solved()).toBe(false);

    const stolen = await b.json<{ ticket: { subject: string } }>("/api/tickets/201", { headers: { "x-tenant-id": "globex" } });
    expect(stolen.status).toBe(200);
    expect(stolen.body.ticket.subject).toContain("phishing");
    await expectSolvedOnce(lab, "medium", () => b.fetch("/api/tickets", { headers: { "x-tenant-id": "globex" } }), xp0);
    await lab.stop();
  });

  it("ac-workflow-edit-after-approval: the legitimate flow never solves; edit-after-approval then pay does", async () => {
    // Part A — legitimate behaviour on its own instance.
    const legit = await launch(t, "ac-workflow-edit-after-approval");
    const a = legit.browser();
    await formLogin(a, "alice", "practice123");
    expect((await a.json<{ expenses: unknown[] }>("/api/expenses")).body.expenses).toHaveLength(2);
    expect((await a.fetch("/api/expenses/100/pay", { method: "POST" })).status).toBe(409); // not approved yet
    expect((await a.fetch("/api/expenses/100/approve", { method: "POST" })).status).toBe(403); // not a manager
    const created = await jsonPost(a, "/api/expenses", { description: "Cab", amount: 30 });
    expect(created.status).toBe(201);
    const newId = (created.body as { expense: { id: number } }).expense.id;
    const mgr = legit.browser();
    await formLogin(mgr, "bob", "Mgr-Approve!55");
    expect((await mgr.fetch(`/api/expenses/${newId}/approve`, { method: "POST" })).status).toBe(200);
    expect((await a.fetch(`/api/expenses/${newId}/pay`, { method: "POST" })).status).toBe(200);
    expect((await a.fetch("/api/expenses/101/pay", { method: "POST" })).status).toBe(200); // unchanged approved expense
    expect((await a.fetch("/api/expenses/101/pay", { method: "POST" })).status).toBe(409); // never twice
    expect((await jsonPost(a, "/api/expenses/200", { amount: 1 }, "PATCH")).status).toBe(403); // someone else's
    expect(await legit.solved()).toBe(false);
    await legit.stop();

    // Part B — the exploit on a fresh instance.
    const lab = await launch(t, "ac-workflow-edit-after-approval");
    const xp0 = await lab.xp();
    const b = lab.browser();
    await formLogin(b, "alice", "practice123");
    expect((await jsonPost(b, "/api/expenses/101", { amount: 5000 }, "PATCH")).status).toBe(200);
    expect(await lab.solved()).toBe(false); // editing alone is not yet the harm
    const paid = await b.json<{ paid: number }>("/api/expenses/101/pay", { method: "POST" });
    expect(paid.status).toBe(200);
    expect(paid.body.paid).toBe(5000);
    await expectSolvedOnce(lab, "hard", () => b.fetch("/api/expenses/101/pay", { method: "POST" }), xp0);
    expect((await jsonPost(b, "/api/expenses/101", { amount: 1 }, "PATCH")).status).toBe(409); // paid is locked
    await lab.stop();
  });

  it("a second learner's instance is independent: solving one never solves another's", async () => {
    const l1 = await launch(t, "ac-bfla-remove-member");
    const l2 = await launch(t, "ac-bfla-remove-member", await newLearner(t));
    const b1 = l1.browser();
    await formLogin(b1, "alice", "practice123");
    await b1.fetch("/api/members/3/remove", { method: "POST" });
    expect(await l1.solved()).toBe(true);
    expect(await l2.solved()).toBe(false);
    const b2 = l2.browser();
    await formLogin(b2, "alice", "practice123");
    expect((await b2.json<{ members: unknown[] }>("/api/members")).body.members).toHaveLength(5); // untouched
    await l1.stop();
    await l2.stop();
  });
});
