import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { TcpForwarder } from "./tcp-forwarder.js";
import { pollHealth, type KnownInstance, type LabRuntime, type SpawnRequest, type SpawnResult } from "./types.js";

const execFileAsync = promisify(execFile);

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = async (cmd, args) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 8 * 1024 * 1024 });
  return { stdout: String(stdout), stderr: String(stderr) };
};

/** Network alias under which lab containers reach the control plane. */
export const CONTROL_ALIAS = "nulllab-control";
const LABEL_MANAGED = "nulllab.managed";
const LABEL_INSTANCE = "nulllab.instance";
const LABEL_OWNER = "nulllab.owner";

export interface DockerRuntimeOptions {
  repoRoot: string;
  /** Name of the `--internal` Docker network lab containers live on. */
  network: string;
  /** Image repository name; the full image is `${imagePrefix}:${imageTag}`. */
  imagePrefix: string;
  imageTag: string;
  /**
   * Name of the container the control plane itself runs in. It is attached
   * to the lab network so that (a) labs can call back to /internal routes and
   * (b) its TCP forwarders can reach lab containers.
   */
  selfContainer: string;
  /** Interface the in-container forwarders listen on (published to host loopback by Compose). */
  forwarderBindHost?: string;
  /** Injectable for tests; defaults to the real `docker` CLI. */
  exec?: ExecFn;
}

/**
 * EXPERIMENTAL — written to the same LabRuntime contract as ProcessRuntime
 * but NOT yet exercised against a real Docker daemon by the author's test
 * environment (no daemon was available). Command construction is covered by
 * unit tests against a stub CLI; `npm run docker:selftest` is the real check
 * and must be run by a person on a Docker-enabled machine.
 *
 * Topology (control plane running inside the Compose service `nulllab`):
 *
 *   browser/Burp ──► 127.0.0.1:<port> (Compose publishes 5100-5199 to host loopback)
 *        └─► control-plane container: TcpForwarder on 0.0.0.0:<port>
 *               └─► (internal Docker network, no route out) lab container <name>:<port>
 *
 * Each lab container: non-root, read-only root FS, tmpfs /tmp, all
 * capabilities dropped, no-new-privileges, memory/CPU/PID limits, no Docker
 * socket, no host mounts, no published ports of its own, and no egress
 * because the network is created with `--internal`.
 */
export class DockerRuntime implements LabRuntime {
  readonly mode = "docker" as const;
  private readonly exec: ExecFn;
  private readonly forwarders = new Map<string, TcpForwarder>();
  private readonly errors = new Map<string, string>();
  private ready = false;

  constructor(private readonly opts: DockerRuntimeOptions) {
    this.exec = opts.exec ?? defaultExec;
  }

  private get image(): string {
    return `${this.opts.imagePrefix}:${this.opts.imageTag}`;
  }

  private containerName(instanceId: string): string {
    return `${this.opts.imagePrefix}-${instanceId.slice(0, 12)}`;
  }

  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    await this.ensureReady();

    const name = this.containerName(req.instanceId);
    const entryRel = path.relative(this.opts.repoRoot, req.entryScript).split(path.sep).join("/");
    const memory = req.resourceLimits?.memoryMb ?? 128;
    const cpus = req.resourceLimits?.cpus ?? 0.5;

    const args = [
      "run", "-d",
      "--name", name,
      "--label", `${LABEL_MANAGED}=true`,
      "--label", `${LABEL_INSTANCE}=${req.instanceId}`,
      "--label", `${LABEL_OWNER}=${this.opts.selfContainer}`,
      "--network", this.opts.network,
      "--memory", `${memory}m`,
      "--memory-swap", `${memory}m`,
      "--cpus", String(cpus),
      "--pids-limit", "128",
      "--ulimit", "nofile=1024:1024",
      "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,size=32m",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--restart", "no",
      "--stop-timeout", "3",
      "--log-opt", "max-size=1m",
      "-e", `NULLLAB_INSTANCE_ID=${req.instanceId}`,
      "-e", `NULLLAB_INSTANCE_TOKEN=${req.instanceToken}`,
      "-e", `NULLLAB_LAB_ID=${req.labId}`,
      "-e", `NULLLAB_LAB_PORT=${req.port}`,
      // Inside the container the lab must listen on a non-loopback interface,
      // otherwise nothing outside its own network namespace can reach it.
      "-e", "NULLLAB_BIND_HOST=0.0.0.0",
      "-e", `NULLLAB_ORCHESTRATOR_URL=${req.orchestratorInternalUrl}`,
      "-e", "NULLLAB_INSTANCE_DB_PATH=/tmp/instance.db",
      "-e", `NULLLAB_LAB_ENTRY=${entryRel}`,
      "-e", "HOME=/tmp",
      this.image,
    ];

    try {
      await this.exec("docker", args);
    } catch (err) {
      const msg = errText(err);
      this.errors.set(req.instanceId, msg);
      throw new Error(`docker run failed: ${msg}`, { cause: err });
    }

    const forwarder = new TcpForwarder({
      listenHost: this.opts.forwarderBindHost ?? "0.0.0.0",
      listenPort: req.port,
      targetHost: name,
      targetPort: req.port,
    });
    try {
      await forwarder.listen();
    } catch (err) {
      await this.removeContainer(name);
      throw new Error(`could not open forwarder port ${req.port}: ${errText(err)}`, { cause: err });
    }
    this.forwarders.set(req.instanceId, forwarder);

    const baseUrl = `http://127.0.0.1:${req.port}`;
    return { baseUrl, healthUrl: baseUrl, pid: null, containerName: name };
  }

  async stop(instanceId: string): Promise<void> {
    const fwd = this.forwarders.get(instanceId);
    if (fwd) {
      this.forwarders.delete(instanceId);
      await fwd.close().catch(() => undefined);
    }
    await this.removeContainer(this.containerName(instanceId));
    this.errors.delete(instanceId);
  }

  async isAlive(instanceId: string): Promise<boolean> {
    if (!this.forwarders.has(instanceId)) return false;
    try {
      const { stdout } = await this.exec("docker", ["inspect", "-f", "{{.State.Running}}", this.containerName(instanceId)]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  waitHealthy(url: string, timeoutMs = 30_000, instanceId?: string): Promise<boolean> {
    return pollHealth(url, timeoutMs, 300, instanceId ? () => this.isAlive(instanceId) : undefined);
  }

  lastError(instanceId: string): string | undefined {
    return this.errors.get(instanceId);
  }

  /** Removes every container this control plane previously started (they are all stale after a restart). */
  async reapOrphans(_known: KnownInstance[]): Promise<number> {
    let ids: string[];
    try {
      const { stdout } = await this.exec("docker", [
        "ps", "-aq",
        "--filter", `label=${LABEL_MANAGED}=true`,
        "--filter", `label=${LABEL_OWNER}=${this.opts.selfContainer}`,
      ]);
      ids = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return 0;
    }
    for (const id of ids) await this.removeContainer(id);
    return ids.length;
  }

  private async removeContainer(nameOrId: string): Promise<void> {
    try {
      await this.exec("docker", ["rm", "-f", nameOrId]);
    } catch (err) {
      const msg = errText(err);
      if (!/No such container/i.test(msg)) console.warn(`[docker-runtime] failed to remove ${nameOrId}: ${msg}`);
    }
  }

  /** One-time: image present, internal network exists, control plane attached to it. */
  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    try {
      await this.exec("docker", ["image", "inspect", this.image]);
    } catch {
      throw new Error(
        `lab image "${this.image}" not found. Build it once with: docker compose --profile docker-mode build lab-image`,
      );
    }
    try {
      await this.exec("docker", ["network", "inspect", this.opts.network]);
    } catch {
      // internal: true => no outbound route at all for anything on this network
      await this.exec("docker", ["network", "create", "--internal", "--label", `${LABEL_MANAGED}=true`, this.opts.network]);
    }
    try {
      await this.exec("docker", ["network", "connect", "--alias", CONTROL_ALIAS, this.opts.network, this.opts.selfContainer]);
    } catch (err) {
      if (!/already exists|already connected/i.test(errText(err))) {
        throw new Error(
          `could not attach the control plane container "${this.opts.selfContainer}" to network ${this.opts.network}: ${errText(err)}. ` +
            `Docker mode requires the control plane to run in a container whose name is set in NULLLAB_SELF_CONTAINER.`,
          { cause: err },
        );
      }
    }
    this.ready = true;
  }
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).slice(0, 500);
}

/** Used by scripts/ to confirm the Docker CLI is present and the daemon reachable. */
export async function dockerAvailable(exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}
