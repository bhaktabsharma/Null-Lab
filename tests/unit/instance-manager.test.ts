import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { PortAllocator, type KnownInstance, type LabRuntime, type SpawnRequest, type SpawnResult } from "../../runtime/orchestrator/src/index.js";
import { loadEnv } from "../../apps/api/src/env.js";
import { openControlDb, type ControlDb } from "../../apps/api/src/db.js";
import { loadCatalog } from "../../apps/api/src/labs/catalog.js";
import { InstanceManager } from "../../apps/api/src/instances/service.js";

process.env.NULLLAB_TEST_SILENT = "1";

class FakeRuntime implements LabRuntime {
  readonly mode = "process" as const;
  spawnError: Error | null = null;
  healthy = true;
  alive = true;
  detail: string | undefined;
  stopped: string[] = [];
  reapedWith: KnownInstance[] = [];
  dbPaths = new Map<string, string>();

  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    if (this.spawnError) throw this.spawnError;
    // Pretend the lab created its per-instance database file.
    fs.writeFileSync(req.instanceDbPath, "x");
    this.dbPaths.set(req.instanceId, req.instanceDbPath);
    const baseUrl = `http://127.0.0.1:${req.port}`;
    return { baseUrl, healthUrl: baseUrl, pid: 4242, containerName: null };
  }
  async stop(id: string) {
    this.stopped.push(id);
  }
  async isAlive() {
    return this.alive;
  }
  async waitHealthy() {
    return this.healthy;
  }
  lastError() {
    return this.detail;
  }
  async reapOrphans(known: KnownInstance[]) {
    this.reapedWith = known;
    return known.length;
  }
}

let db: ControlDb;
let rt: FakeRuntime;
let ports: PortAllocator;
let mgr: InstanceManager;
const LAB = "idor-invoice-leak";

beforeEach(() => {
  const env = loadEnv({ SESSION_SECRET: "unit-test-secret-0123456789abcdef", DATABASE_PATH: ":memory:" });
  db = openControlDb(env);
  const catalog = loadCatalog(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, is_guest, xp, created_at) VALUES ('u1','t',NULL,1,0,?)`).run(new Date().toISOString());
  rt = new FakeRuntime();
  ports = new PortAllocator(6540, 6545);
  mgr = new InstanceManager(db, catalog, rt, ports, env, "http://127.0.0.1:4000");
});

const status = (id: string) => (db.prepare(`SELECT status FROM lab_instances WHERE id = ?`).get(id) as { status: string }).status;

describe("InstanceManager failure handling and cleanup", () => {
  it("a spawn failure stops the target, releases the port, and marks the instance errored", async () => {
    rt.spawnError = new Error("no such binary");
    const res = await mgr.launch("u1", LAB);
    expect(res.ok).toBe(false);
    expect(rt.stopped).toHaveLength(1);
    expect(await ports.allocate()).toBe(6540); // port was handed back, not leaked
    const row = db.prepare(`SELECT id, status FROM lab_instances`).get() as { id: string; status: string };
    expect(row.status).toBe("error");
  });

  it("an unhealthy target is torn down and the real failure detail reaches the learner", async () => {
    rt.healthy = false;
    rt.detail = "exited (code=3 signal=null) — boom: simulated startup failure";
    const res = await mgr.launch("u1", LAB);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("boom: simulated startup failure");
    expect(rt.stopped).toHaveLength(1);
    expect(await ports.allocate()).toBe(6540);
    const leftover = fs.readdirSync(new URL("../../data/instances/", import.meta.url)).filter((f) => rt.dbPaths.size && [...rt.dbPaths.values()].some((p) => p.endsWith(f)));
    expect(leftover).toHaveLength(0); // db file removed
  });

  it("does not keep reporting 'running' for a target that died", async () => {
    const res = await mgr.launch("u1", LAB);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    rt.alive = false;
    rt.detail = "exited (code=1 signal=null)";
    const dto = await mgr.getDTOForUser("u1", res.instance.id);
    expect(dto?.status).toBe("error");
    expect(status(res.instance.id)).toBe("error");
    expect(rt.stopped).toContain(res.instance.id);
  });

  it("stop() deletes the instance's database file and frees its port", async () => {
    const res = await mgr.launch("u1", LAB);
    if (!res.ok) throw new Error("launch failed");
    const dbPath = rt.dbPaths.get(res.instance.id)!;
    expect(fs.existsSync(dbPath)).toBe(true);
    await mgr.stop(res.instance.id);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(status(res.instance.id)).toBe("stopped");
    expect(await ports.allocate()).toBe(6540);
  });

  it("reset() yields a different instance id and token, and removes the old data file", async () => {
    const first = await mgr.launch("u1", LAB);
    if (!first.ok) throw new Error("launch failed");
    const oldDb = rt.dbPaths.get(first.instance.id)!;
    const oldToken = (db.prepare(`SELECT instance_token t FROM lab_instances WHERE id = ?`).get(first.instance.id) as { t: string }).t;

    const second = await mgr.reset("u1", first.instance.id);
    if (!second.ok) throw new Error("reset failed");
    expect(second.instance.id).not.toBe(first.instance.id);
    expect(fs.existsSync(oldDb)).toBe(false);
    expect(db.prepare(`SELECT 1 FROM lab_instances WHERE id = ?`).get(first.instance.id)).toBeUndefined();
    const newToken = (db.prepare(`SELECT instance_token t FROM lab_instances WHERE id = ?`).get(second.instance.id) as { t: string }).t;
    expect(newToken).not.toBe(oldToken);
    await mgr.stopAll();
  });

  it("reapStaleOnBoot() asks the runtime to kill leftovers, then marks rows stopped and removes their data", async () => {
    const res = await mgr.launch("u1", LAB);
    if (!res.ok) throw new Error("launch failed");
    const dbPath = rt.dbPaths.get(res.instance.id)!;

    // Simulate a restart: a fresh manager over the same database.
    const fresh = new InstanceManager(db, loadCatalog(db), rt, new PortAllocator(6540, 6545), loadEnv({ SESSION_SECRET: "unit-test-secret-0123456789abcdef", DATABASE_PATH: ":memory:" }), "http://127.0.0.1:4000");
    await fresh.reapStaleOnBoot();

    expect(rt.reapedWith).toEqual([{ instanceId: res.instance.id, pid: 4242 }]);
    expect(status(res.instance.id)).toBe("stopped");
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});

describe("env parsing", () => {
  it('treats NULLLAB_CHROMIUM_NO_SANDBOX="false" as false (z.coerce.boolean would say true)', () => {
    const base = { SESSION_SECRET: "unit-test-secret-0123456789abcdef" };
    expect(loadEnv({ ...base, NULLLAB_CHROMIUM_NO_SANDBOX: "false" }).NULLLAB_CHROMIUM_NO_SANDBOX).toBe(false);
    expect(loadEnv({ ...base, NULLLAB_CHROMIUM_NO_SANDBOX: "true" }).NULLLAB_CHROMIUM_NO_SANDBOX).toBe(true);
    expect(loadEnv({ ...base, NULLLAB_CHROMIUM_NO_SANDBOX: true }).NULLLAB_CHROMIUM_NO_SANDBOX).toBe(true);
    expect(loadEnv(base).NULLLAB_CHROMIUM_NO_SANDBOX).toBe(false);
  });

  it("rejects a LAB_BIND_HOST that is not an IP address", () => {
    expect(() => loadEnv({ SESSION_SECRET: "unit-test-secret-0123456789abcdef", LAB_BIND_HOST: "not-an-ip" })).toThrow(/LAB_BIND_HOST/);
    expect(loadEnv({ SESSION_SECRET: "unit-test-secret-0123456789abcdef", LAB_BIND_HOST: "0.0.0.0" }).LAB_BIND_HOST).toBe("0.0.0.0");
  });
});
