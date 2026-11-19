import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessRuntime, INSTANCE_MARKER, type SpawnRequest } from "../../runtime/orchestrator/src/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const STUB = path.join(REPO_ROOT, "tests/fixtures/stub-lab.ts");
const CRASH = path.join(REPO_ROOT, "tests/fixtures/stub-crash.ts");

process.env.NULLLAB_TEST_SILENT = "1";

function req(over: Partial<SpawnRequest> & { port: number }): SpawnRequest {
  return {
    instanceId: `test-${Math.random().toString(36).slice(2, 10)}-${over.port}`,
    instanceToken: "tok",
    labId: "stub",
    entryScript: STUB,
    bindHost: "127.0.0.1",
    orchestratorInternalUrl: "http://127.0.0.1:1",
    instanceDbPath: ":memory:",
    ...over,
  };
}

const markerProcs = (id: string): string[] =>
  execFileSync("ps", ["-eww", "-o", "pid=,args="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(`${INSTANCE_MARKER}${id}`));

function externalIPv4(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  return undefined;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 800 });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.once("timeout", () => (s.destroy(), resolve(false)));
  });
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe("ProcessRuntime networking", () => {
  const ext = externalIPv4();

  it("binds loopback by default: reachable on 127.0.0.1, NOT on a non-loopback interface", async () => {
    if (!ext) return; // no external interface in this environment
    const rt = new ProcessRuntime(REPO_ROOT);
    const r = req({ port: 6500, bindHost: "127.0.0.1" });
    cleanup.push(() => rt.stop(r.instanceId));
    const res = await rt.spawn(r);
    expect(await rt.waitHealthy(res.healthUrl, 8000, r.instanceId)).toBe(true);
    expect(await canConnect("127.0.0.1", 6500)).toBe(true);
    expect(await canConnect(ext, 6500)).toBe(false);
  });

  it("binds 0.0.0.0 when asked (what a published container port requires)", async () => {
    if (!ext) return;
    const rt = new ProcessRuntime(REPO_ROOT);
    const r = req({ port: 6501, bindHost: "0.0.0.0" });
    cleanup.push(() => rt.stop(r.instanceId));
    const res = await rt.spawn(r);
    expect(await rt.waitHealthy(res.healthUrl, 8000, r.instanceId)).toBe(true);
    expect(await canConnect(ext, 6501)).toBe(true);
  });
});

describe("ProcessRuntime lifecycle", () => {
  it("stop() kills the whole process tree and frees the port; stop() twice is harmless", async () => {
    const rt = new ProcessRuntime(REPO_ROOT);
    const r = req({ port: 6502 });
    const res = await rt.spawn(r);
    expect(await rt.waitHealthy(res.healthUrl, 8000, r.instanceId)).toBe(true);
    expect(markerProcs(r.instanceId).length).toBeGreaterThan(0);

    await rt.stop(r.instanceId);
    expect(markerProcs(r.instanceId)).toHaveLength(0);
    expect(await canConnect("127.0.0.1", 6502)).toBe(false);
    expect(await rt.isAlive(r.instanceId)).toBe(false);
    await expect(rt.stop(r.instanceId)).resolves.toBeUndefined();
  });

  it("detects a target that crashes on startup immediately, with the real reason", async () => {
    const rt = new ProcessRuntime(REPO_ROOT);
    const r = req({ port: 6503, entryScript: CRASH });
    cleanup.push(() => rt.stop(r.instanceId));
    const res = await rt.spawn(r);
    const started = Date.now();
    expect(await rt.waitHealthy(res.healthUrl, 10_000, r.instanceId)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000); // did not wait out the 10s timeout
    expect(await rt.isAlive(r.instanceId)).toBe(false);
    expect(rt.lastError(r.instanceId)).toMatch(/boom: simulated startup failure/);
  });

  it("reapOrphans() kills a target that outlived its control plane — and only that target", async () => {
    // "Control plane #1" starts a lab then vanishes without cleaning up.
    const first = new ProcessRuntime(REPO_ROOT);
    const r = req({ port: 6504 });
    const res = await first.spawn(r);
    expect(await first.waitHealthy(res.healthUrl, 8000, r.instanceId)).toBe(true);

    // A bystander process that must NOT be touched.
    const bystander = (await import("node:child_process")).spawn("sleep", ["30"], { stdio: "ignore" });
    cleanup.push(async () => void bystander.kill("SIGKILL"));

    // "Control plane #2" boots with no memory of #1's children.
    const second = new ProcessRuntime(REPO_ROOT);
    const reaped = await second.reapOrphans([
      { instanceId: r.instanceId, pid: res.pid },
      { instanceId: "unrelated-id-with-no-process", pid: bystander.pid ?? null }, // wrong pid recorded: must not kill it
    ]);
    expect(reaped).toBe(1);
    expect(markerProcs(r.instanceId)).toHaveLength(0);
    expect(await canConnect("127.0.0.1", 6504)).toBe(false);
    expect(() => process.kill(bystander.pid!, 0)).not.toThrow(); // still alive

    await first.stop(r.instanceId);
  });
});
