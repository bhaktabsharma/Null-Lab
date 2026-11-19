export interface SpawnRequest {
  instanceId: string;
  instanceToken: string;
  labId: string;
  /** Absolute path to the lab target's server entry script. */
  entryScript: string;
  port: number;
  /**
   * Interface the lab binds to. 127.0.0.1 for host-side process mode;
   * runtimes that put the lab in a container override this internally.
   */
  bindHost: string;
  /** URL the lab target uses to reach the control plane's /internal routes. */
  orchestratorInternalUrl: string;
  /** Absolute host path (process mode). Docker mode ignores this and uses a container-local tmpfs path. */
  instanceDbPath: string;
  resourceLimits?: { memoryMb: number; cpus: number };
  allowOutbound?: string[];
}

export interface SpawnResult {
  /** The URL a learner's browser or Burp Suite uses to reach the target. */
  baseUrl: string;
  /** The URL the control plane polls for /healthz (usually the same as baseUrl). */
  healthUrl: string;
  /** Process id for process-mode instances; null for docker-mode. */
  pid: number | null;
  /** Docker container name for docker-mode instances; null for process-mode. */
  containerName: string | null;
}

/** An instance the control-plane database believes was alive before a restart. */
export interface KnownInstance {
  instanceId: string;
  pid: number | null;
}

export interface LabRuntime {
  readonly mode: "process" | "docker";
  spawn(req: SpawnRequest): Promise<SpawnResult>;
  stop(instanceId: string): Promise<void>;
  /** True only while the instance's process/container is actually running. */
  isAlive(instanceId: string): Promise<boolean>;
  /**
   * Polls `${url}/healthz`. When `instanceId` is given, gives up immediately
   * if that instance has already died instead of waiting out the timeout.
   */
  waitHealthy(url: string, timeoutMs?: number, instanceId?: string): Promise<boolean>;
  /** The tail of the instance's output / exit status — used to produce actionable launch errors. */
  lastError(instanceId: string): string | undefined;
  /**
   * Kills anything left over from a previous control-plane run (crash,
   * SIGKILL, power loss). Returns how many leftovers were cleaned up.
   */
  reapOrphans(known: KnownInstance[]): Promise<number>;
}

export async function pollHealth(
  url: string,
  timeoutMs: number,
  pollMs: number,
  stillAlive?: () => boolean | Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stillAlive && !(await stillAlive())) return false;
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}
