import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DockerRuntime, TcpForwarder, CONTROL_ALIAS, type ExecFn, type SpawnRequest } from "../../runtime/orchestrator/src/index.js";

/**
 * IMPORTANT: these tests use a stub `docker` CLI. They prove the commands the
 * runtime *would* run carry the isolation flags we claim — they do NOT prove
 * the containers work. That is what `npm run docker:selftest` is for, and it
 * must be run on a machine with a Docker daemon.
 */

interface Call {
  cmd: string;
  args: string[];
}

function stubDocker(opts: { imagePresent?: boolean; networkExists?: boolean; managedIds?: string[]; running?: boolean } = {}) {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const key = args.slice(0, 2).join(" ");
    if (key === "image inspect" && opts.imagePresent === false) throw new Error("No such image");
    if (key === "network inspect" && opts.networkExists === false) throw new Error("No such network");
    if (args[0] === "ps") return { stdout: (opts.managedIds ?? []).join("\n"), stderr: "" };
    if (args[0] === "inspect") return { stdout: opts.running === false ? "false\n" : "true\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { calls, exec };
}

const REPO = "/repo";
const baseReq = (port: number): SpawnRequest => ({
  instanceId: "0123456789abcdef-aaaa",
  instanceToken: "instance-secret-token",
  labId: "idor-invoice-leak",
  entryScript: "/repo/labs/access-control/idor-invoice-leak/server.ts",
  port,
  bindHost: "127.0.0.1",
  orchestratorInternalUrl: `http://${CONTROL_ALIAS}:4000`,
  instanceDbPath: "/host/path/that/must/not/leak.db",
  resourceLimits: { memoryMb: 96, cpus: 0.25 },
});

const make = (exec: ExecFn) =>
  new DockerRuntime({
    repoRoot: REPO,
    network: "nulllab_labnet",
    imagePrefix: "nulllab-lab",
    imageTag: "local",
    selfContainer: "nulllab",
    forwarderBindHost: "127.0.0.1",
    exec,
  });

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of open.splice(0)) await fn();
});

describe("DockerRuntime command construction (stub CLI — not a real Docker run)", () => {
  it("runs the lab with the full isolation profile", async () => {
    const { calls, exec } = stubDocker();
    const rt = make(exec);
    open.push(() => rt.stop(baseReq(6520).instanceId));
    const res = await rt.spawn(baseReq(6520));

    const run = calls.find((c) => c.args[0] === "run")!;
    const a = run.args;
    const flag = (name: string) => a[a.indexOf(name) + 1];

    expect(flag("--network")).toBe("nulllab_labnet");
    expect(flag("--cap-drop")).toBe("ALL");
    expect(flag("--security-opt")).toBe("no-new-privileges");
    expect(a).toContain("--read-only");
    expect(flag("--memory")).toBe("96m");
    expect(flag("--memory-swap")).toBe("96m"); // no swap escape hatch
    expect(flag("--cpus")).toBe("0.25");
    expect(flag("--pids-limit")).toBe("128");
    expect(flag("--restart")).toBe("no");
    expect(a[a.length - 1]).toBe("nulllab-lab:local"); // one shared image, no per-launch build

    // Things that must never appear.
    for (const forbidden of ["--privileged", "-p", "--publish", "-P", "-v", "--volume", "--mount", "--pid", "--cap-add", "--device", "--network=host"]) {
      expect(a, `must not pass ${forbidden}`).not.toContain(forbidden);
    }
    expect(a.join(" ")).not.toMatch(/docker\.sock/);
    expect(a.filter((x) => x === "host").length).toBe(0);

    // The lab must bind a non-loopback interface inside the container, use a
    // container-local db path (not the host path), and call back via the alias.
    const env = a.filter((_, i) => a[i - 1] === "-e");
    expect(env).toContain("NULLLAB_BIND_HOST=0.0.0.0");
    expect(env).toContain("NULLLAB_INSTANCE_DB_PATH=/tmp/instance.db");
    expect(env).toContain(`NULLLAB_ORCHESTRATOR_URL=http://${CONTROL_ALIAS}:4000`);
    expect(env).toContain("NULLLAB_LAB_ENTRY=labs/access-control/idor-invoice-leak/server.ts");
    expect(env.join(" ")).not.toContain("/host/path");

    // Labelled so leftovers can be found and removed later.
    expect(a.join(" ")).toContain("nulllab.managed=true");
    expect(a.join(" ")).toContain("nulllab.owner=nulllab");

    expect(res.baseUrl).toBe("http://127.0.0.1:6520");
    expect(res.containerName).toMatch(/^nulllab-lab-/);
  });

  it("creates the lab network with --internal (no route out) and attaches the control plane", async () => {
    const { calls, exec } = stubDocker({ networkExists: false });
    const rt = make(exec);
    open.push(() => rt.stop(baseReq(6521).instanceId));
    await rt.spawn(baseReq(6521));

    const create = calls.find((c) => c.args[0] === "network" && c.args[1] === "create")!;
    expect(create.args).toContain("--internal");
    const connect = calls.find((c) => c.args[0] === "network" && c.args[1] === "connect")!;
    expect(connect.args).toEqual(expect.arrayContaining(["--alias", CONTROL_ALIAS, "nulllab_labnet", "nulllab"]));
  });

  it("fails with an actionable message when the lab image has not been built", async () => {
    const { exec } = stubDocker({ imagePresent: false });
    const rt = make(exec);
    await expect(rt.spawn(baseReq(6522))).rejects.toThrow(/docker compose --profile docker-mode build lab-image/);
  });

  it("stop() removes the container and closes the forwarder port", async () => {
    const { calls, exec } = stubDocker();
    const rt = make(exec);
    await rt.spawn(baseReq(6523));
    await rt.stop(baseReq(6523).instanceId);
    expect(calls.some((c) => c.args[0] === "rm" && c.args.includes("-f"))).toBe(true);
    const stillOpen = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port: 6523 });
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("error", () => resolve(false));
    });
    expect(stillOpen).toBe(false);
  });

  it("isAlive reflects the container's real running state", async () => {
    const dead = stubDocker({ running: false });
    const rt = make(dead.exec);
    open.push(() => rt.stop(baseReq(6524).instanceId));
    await rt.spawn(baseReq(6524));
    expect(await rt.isAlive(baseReq(6524).instanceId)).toBe(false);
  });

  it("reapOrphans() removes every managed container from a previous run, filtered to this owner", async () => {
    const { calls, exec } = stubDocker({ managedIds: ["abc123", "def456"] });
    const reaped = await make(exec).reapOrphans([]);
    expect(reaped).toBe(2);
    const ps = calls.find((c) => c.args[0] === "ps")!;
    expect(ps.args.join(" ")).toContain("label=nulllab.owner=nulllab");
    expect(calls.filter((c) => c.args[0] === "rm").map((c) => c.args[2])).toEqual(["abc123", "def456"]);
  });
});

describe("TcpForwarder", () => {
  const echoServer = async () => {
    const srv = http.createServer((_req, res) => res.end("hello-from-lab"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    open.push(() => new Promise<void>((r) => srv.close(() => r())));
    return (srv.address() as AddressInfo).port;
  };

  it("relays HTTP bytes unmodified to the target", async () => {
    const targetPort = await echoServer();
    const fwd = new TcpForwarder({ listenHost: "127.0.0.1", listenPort: 6525, targetHost: "127.0.0.1", targetPort });
    await fwd.listen();
    open.push(() => fwd.close());
    const res = await fetch("http://127.0.0.1:6525/");
    expect(await res.text()).toBe("hello-from-lab");
  });

  it("enforces a hard connection cap", async () => {
    const targetPort = await echoServer();
    const fwd = new TcpForwarder({ listenHost: "127.0.0.1", listenPort: 6526, targetHost: "127.0.0.1", targetPort, maxConnections: 2 });
    await fwd.listen();
    open.push(() => fwd.close());

    const held: net.Socket[] = [];
    for (let i = 0; i < 2; i++) {
      const s = net.connect({ host: "127.0.0.1", port: 6526 });
      await new Promise<void>((r) => s.once("connect", () => r()));
      held.push(s);
    }
    await new Promise((r) => setTimeout(r, 100));
    const third = net.connect({ host: "127.0.0.1", port: 6526 });
    const closed = await new Promise<boolean>((resolve) => {
      third.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 1500);
    });
    held.forEach((s) => s.destroy());
    third.destroy();
    expect(closed).toBe(true);
  });
});
