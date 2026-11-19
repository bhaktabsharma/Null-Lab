import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, CookieClient, type TestApp } from "./helpers.js";
import { buildApp } from "../../apps/api/src/app.js";
import { INSTANCE_MARKER } from "../../runtime/orchestrator/src/index.js";

const LAB = "idor-invoice-leak"; // keeps its data in memory
const DB_LAB = "sqli-product-search"; // keeps its data in a per-instance SQLite file

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

describe("real-process lifecycle: reset, stop, and progress durability", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4120, labPortStart: 6600, labPortEnd: 6620 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("reset replaces the target: old exploit state is gone, XP/progress is not", async () => {
    const client = new CookieClient(t.baseUrl);
    await client.json("/api/auth/guest", { method: "POST" });

    const launch1 = await client.json<{ instance: { id: string; baseUrl: string; solved: boolean } }>(`/api/labs/${LAB}/instances`, { method: "POST" });
    const inst1 = launch1.body.instance;
    expect(await reachable(inst1.baseUrl)).toBe(true);

    // Solve it for real. Capture the target's raw session cookie so we can replay it after reset.
    const loginRes = await fetch(`${inst1.baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=practice123",
      redirect: "manual",
    });
    const oldSessionCookie = loginRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(oldSessionCookie).toContain("shopmart_session=");
    const exploit = await fetch(`${inst1.baseUrl}/invoices/1002`, { headers: { cookie: oldSessionCookie } });
    expect(exploit.status).toBe(200);
    const solved = await client.json<{ instance: { solved: boolean } }>(`/api/instances/${inst1.id}`);
    expect(solved.body.instance.solved).toBe(true);
    const xpBefore = (await client.json<{ xp: number }>("/api/progress")).body.xp;
    expect(xpBefore).toBe(50);

    // Reset.
    const reset = await client.json<{ instance: { id: string; baseUrl: string; solved: boolean } }>(`/api/instances/${inst1.id}/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    const inst2 = reset.body.instance;

    expect(inst2.id).not.toBe(inst1.id);
    expect(inst2.solved).toBe(false); // the *instance* starts clean...
    expect((await client.json<{ xp: number }>("/api/progress")).body.xp).toBe(xpBefore); // ...the learner's progress is untouched
    // Nothing from the old instance's process tree survives.
    const survivors = execFileSync("ps", ["-eww", "-o", "args="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`${INSTANCE_MARKER}${inst1.id}`));
    expect(survivors).toHaveLength(0);

    // A session issued by the OLD instance (signed with its token) must not be honoured by the NEW one.
    const replay = await fetch(`${inst2.baseUrl}/invoices/1002`, { headers: { cookie: oldSessionCookie }, redirect: "manual" });
    expect(replay.status).not.toBe(200);
    expect(await replay.text()).not.toContain("899.00");
    // And the same invoice is still reachable for a legitimately authenticated session on the new instance (control).
    const loginNew = await fetch(`${inst2.baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=practice123",
      redirect: "manual",
    });
    const newCookie = loginNew.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect((await fetch(`${inst2.baseUrl}/invoices/1001`, { headers: { cookie: newCookie } })).status).toBe(200);

    await client.fetch(`/api/instances/${inst2.id}/stop`, { method: "POST" });
  });

  it("stop shuts the target down, deletes its data file, and frees the port for reuse", async () => {
    const client = new CookieClient(t.baseUrl);
    await client.json("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>(`/api/labs/${DB_LAB}/instances`, { method: "POST" });
    const { id, baseUrl } = launch.body.instance;
    const dbPath = (t.db.prepare(`SELECT db_path FROM lab_instances WHERE id = ?`).get(id) as { db_path: string }).db_path;
    expect(fs.existsSync(dbPath)).toBe(true); // the lab really created it

    const stop = await client.json(`/api/instances/${id}/stop`, { method: "POST" });
    expect(stop.status).toBe(200);
    expect(await reachable(baseUrl)).toBe(false);
    for (const suffix of ["", "-wal", "-shm"]) expect(fs.existsSync(dbPath + suffix)).toBe(false);

    // The freed port is handed out again.
    const again = await client.json<{ instance: { id: string; baseUrl: string } }>(`/api/labs/${DB_LAB}/instances`, { method: "POST" });
    expect(again.body.instance.baseUrl).toBe(baseUrl);
    await client.fetch(`/api/instances/${again.body.instance.id}/stop`, { method: "POST" });
  });

  it("reset of a database-backed lab discards the old database and starts a fresh one", async () => {
    const client = new CookieClient(t.baseUrl);
    await client.json("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string } }>(`/api/labs/${DB_LAB}/instances`, { method: "POST" });
    const oldId = launch.body.instance.id;
    const oldDb = (t.db.prepare(`SELECT db_path FROM lab_instances WHERE id = ?`).get(oldId) as { db_path: string }).db_path;
    expect(fs.existsSync(oldDb)).toBe(true);

    const reset = await client.json<{ instance: { id: string } }>(`/api/instances/${oldId}/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    const newDb = (t.db.prepare(`SELECT db_path FROM lab_instances WHERE id = ?`).get(reset.body.instance.id) as { db_path: string }).db_path;
    expect(newDb).not.toBe(oldDb);
    expect(fs.existsSync(oldDb)).toBe(false);
    expect(fs.existsSync(newDb)).toBe(true);
    await client.fetch(`/api/instances/${reset.body.instance.id}/stop`, { method: "POST" });
  });

  it("a user cannot stop or reset another user's instance", async () => {
    const owner = new CookieClient(t.baseUrl);
    const other = new CookieClient(t.baseUrl);
    await owner.json("/api/auth/guest", { method: "POST" });
    await other.json("/api/auth/guest", { method: "POST" });
    const launch = await owner.json<{ instance: { id: string; baseUrl: string } }>(`/api/labs/${LAB}/instances`, { method: "POST" });
    const { id, baseUrl } = launch.body.instance;

    expect((await other.json(`/api/instances/${id}/stop`, { method: "POST" })).status).toBe(404);
    expect((await other.json(`/api/instances/${id}/reset`, { method: "POST" })).status).toBe(404);
    expect(await reachable(baseUrl)).toBe(true); // still up

    await owner.fetch(`/api/instances/${id}/stop`, { method: "POST" });
  });
});

describe("control plane crash recovery (real processes, file-backed database)", () => {
  it("a lab left running by a crashed control plane is killed on the next boot", async () => {
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nulllab-reap-")), "control.db");
    process.env.NULLLAB_TEST_SILENT = "1";
    const env = {
      API_PORT: 4121,
      DATABASE_PATH: dbFile,
      SESSION_SECRET: "test-session-secret-0123456789abcdef",
      WEB_ORIGIN: "http://localhost:5173",
      LAB_PORT_RANGE_START: 6630,
      LAB_PORT_RANGE_END: 6640,
    };

    // "Control plane #1": launches a lab, then is never shut down cleanly.
    const first = await buildApp({ envOverrides: env });
    await first.app.listen({ port: 4121, host: "127.0.0.1" });
    const client = new CookieClient("http://127.0.0.1:4121");
    await client.json("/api/auth/guest", { method: "POST" });
    const launch = await client.json<{ instance: { id: string; baseUrl: string } }>(`/api/labs/${LAB}/instances`, { method: "POST" });
    const { id, baseUrl } = launch.body.instance;
    expect(await reachable(baseUrl)).toBe(true);

    // "Control plane #2" boots against the same database. It has no handle on #1's child.
    const second = await buildApp({ envOverrides: { ...env, API_PORT: 4122 } });

    expect(await reachable(baseUrl)).toBe(false); // the stale target is dead
    expect((second.db.prepare(`SELECT status FROM lab_instances WHERE id = ?`).get(id) as { status: string }).status).toBe("stopped");

    await first.app.close();
    first.db.close();
    await second.app.close();
    second.db.close();
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  });
});
