import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { pollHealth, type KnownInstance, type LabRuntime, type SpawnRequest, type SpawnResult } from "./types.js";

/** Every lab process carries this argv marker so leftovers can be identified safely after a crash. */
export const INSTANCE_MARKER = "--nulllab-instance=";

const OUTPUT_TAIL_BYTES = 4000;

interface Tracked {
  child: ChildProcess;
  exited: boolean;
  exitInfo?: string;
  tail: string;
}

/**
 * Runs each lab instance as its own OS process, on its own port, with its
 * own SQLite file, started with ONLY the narrow env vars the lab-sdk
 * contract defines (no control-plane secrets, no DB credentials).
 *
 * Process mode is *logical* isolation, not a sandbox: every lab runs as the
 * same OS user as the control plane. That is acceptable for practising
 * against synthetic, intentionally-vulnerable apps on your own machine, but
 * it is not a security boundary — see docs/architecture.md and
 * docs/docker-mode.md for the container-level alternative.
 *
 * Lifecycle guarantees this class provides:
 *  - each lab is started in its own process group, and stop() kills the
 *    whole group (tsx starts the real server as a child);
 *  - a lab that dies is detected (isAlive / waitHealthy) rather than
 *    reported as running;
 *  - leftovers from a crashed control plane are found by their argv marker
 *    and killed on the next boot (reapOrphans);
 *  - a synchronous exit hook makes a best effort to kill children if the
 *    control plane itself exits unexpectedly.
 */
export class ProcessRuntime implements LabRuntime {
  readonly mode = "process" as const;
  private tracked = new Map<string, Tracked>();
  private exitHookInstalled = false;

  constructor(private readonly repoRoot: string) {}

  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    const tsxBin = path.join(this.repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    if (!fs.existsSync(tsxBin)) {
      throw new Error(
        `[process-runtime] tsx binary not found at ${tsxBin}. Run "npm install" at the repo root (tsx must be installed, including in production images).`,
      );
    }
    if (!fs.existsSync(req.entryScript)) {
      throw new Error(`[process-runtime] lab entry script not found: ${req.entryScript}`);
    }
    this.installExitHook();

    const posix = process.platform !== "win32";
    const child = spawn(tsxBin, [req.entryScript, `${INSTANCE_MARKER}${req.instanceId}`], {
      cwd: this.repoRoot,
      // Own process group on POSIX so the whole tree can be signalled at once.
      detached: posix,
      env: {
        // Deliberately NOT process.env spread in full — the lab target gets
        // only what it needs (plus PATH so Node itself can resolve).
        PATH: process.env.PATH,
        NODE_ENV: process.env.NODE_ENV ?? "development",
        NULLLAB_INSTANCE_ID: req.instanceId,
        NULLLAB_INSTANCE_TOKEN: req.instanceToken,
        NULLLAB_LAB_ID: req.labId,
        NULLLAB_LAB_PORT: String(req.port),
        NULLLAB_BIND_HOST: req.bindHost,
        NULLLAB_ORCHESTRATOR_URL: req.orchestratorInternalUrl,
        NULLLAB_INSTANCE_DB_PATH: req.instanceDbPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const entry: Tracked = { child, exited: false, tail: "" };
    this.tracked.set(req.instanceId, entry);

    const label = `[lab:${req.labId}:${req.instanceId.slice(0, 8)}]`;
    const capture = (buf: Buffer, sink: NodeJS.WriteStream) => {
      entry.tail = (entry.tail + buf.toString()).slice(-OUTPUT_TAIL_BYTES);
      if (!process.env.NULLLAB_TEST_SILENT) sink.write(`${label} ${buf}`);
    };
    child.stdout?.on("data", (buf: Buffer) => capture(buf, process.stdout));
    child.stderr?.on("data", (buf: Buffer) => capture(buf, process.stderr));
    child.on("error", (err) => {
      entry.exited = true;
      entry.exitInfo = `failed to start: ${err.message}`;
    });
    child.on("exit", (code, signal) => {
      entry.exited = true;
      entry.exitInfo = `exited (code=${code} signal=${signal})`;
      if (!process.env.NULLLAB_TEST_SILENT) console.log(`[process-runtime] instance ${req.instanceId} ${entry.exitInfo}`);
    });

    const baseUrl = `http://127.0.0.1:${req.port}`;
    return { baseUrl, healthUrl: baseUrl, pid: child.pid ?? null, containerName: null };
  }

  async stop(instanceId: string): Promise<void> {
    const entry = this.tracked.get(instanceId);
    if (!entry) return;
    await killGroup(entry);
    this.tracked.delete(instanceId);
  }

  async isAlive(instanceId: string): Promise<boolean> {
    const entry = this.tracked.get(instanceId);
    return !!entry && !entry.exited && entry.child.exitCode === null && entry.child.signalCode === null;
  }

  waitHealthy(url: string, timeoutMs = 10_000, instanceId?: string): Promise<boolean> {
    return pollHealth(url, timeoutMs, 200, instanceId ? () => this.isAlive(instanceId) : undefined);
  }

  lastError(instanceId: string): string | undefined {
    const entry = this.tracked.get(instanceId);
    if (!entry) return undefined;
    const parts = [entry.exitInfo, entry.tail.trim().split("\n").slice(-6).join("\n")].filter(Boolean);
    return parts.length ? parts.join(" — ") : undefined;
  }

  /**
   * Kills lab processes that outlived a previous control-plane run. Only
   * processes whose argv carries this exact instance's marker are touched,
   * so a recycled PID belonging to something else is never killed.
   */
  async reapOrphans(known: KnownInstance[]): Promise<number> {
    if (process.platform === "win32") return 0; // no `ps`; Windows users should prefer WSL2 or Docker
    let reaped = 0;
    let table: string;
    try {
      table = execFileSync("ps", ["-eww", "-o", "pid=,args="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    } catch {
      return 0;
    }
    const lines = table.split("\n");
    for (const k of known) {
      const marker = `${INSTANCE_MARKER}${k.instanceId}`;
      const pids = lines
        .filter((l) => l.includes(marker))
        .map((l) => Number(l.trim().split(/\s+/, 1)[0]))
        .filter((n) => Number.isInteger(n) && n > 1 && n !== process.pid);
      if (pids.length === 0) continue;
      for (const pid of pids) signalPid(pid, "SIGTERM");
      await sleep(400);
      for (const pid of pids) signalPid(pid, "SIGKILL");
      reaped += 1;
    }
    return reaped;
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.on("exit", () => {
      for (const { child } of this.tracked.values()) {
        if (child.pid) signalGroup(child.pid, "SIGKILL");
      }
    });
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    signalPid(pid, signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    signalPid(pid, signal);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function killGroup(entry: Tracked): Promise<void> {
  const { child } = entry;
  const pid = child.pid;
  if (!pid) return;
  if (!entry.exited) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    signalGroup(pid, "SIGTERM");
    await Promise.race([exited, sleep(3000)]);
  }
  // Whether or not the leader exited cleanly, make sure nothing in its group survives.
  signalGroup(pid, "SIGKILL");
}
