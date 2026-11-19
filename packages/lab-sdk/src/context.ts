import { isIP } from "node:net";

/**
 * Every lab target process is spawned by the orchestrator with a small set
 * of env vars that identify the running instance. The lab target never
 * receives control-plane secrets, database credentials, or host access —
 * only this narrow context.
 */
export interface LabContext {
  instanceId: string;
  instanceToken: string;
  labId: string;
  port: number;
  /**
   * Interface the lab target listens on. Defaults to loopback, which is
   * right for process mode on a developer machine. Inside a container the
   * orchestrator sets 0.0.0.0 — a service bound to the container's own
   * loopback can never be reached through a published port, which is why
   * this is configurable rather than hard-coded.
   */
  bindHost: string;
  orchestratorInternalUrl: string;
  /** Absolute path to this instance's own isolated SQLite file, or ":memory:" */
  instanceDbPath: string;
}

export function loadLabContext(): LabContext {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v) {
      throw new Error(`[lab-sdk] missing required env var ${name} — this process must be started by the NULLLAB orchestrator`);
    }
    return v;
  };

  const bindHost = process.env.NULLLAB_BIND_HOST ?? "127.0.0.1";
  if (isIP(bindHost) === 0) {
    throw new Error(`[lab-sdk] NULLLAB_BIND_HOST must be an IP address, got "${bindHost}"`);
  }

  return {
    instanceId: required("NULLLAB_INSTANCE_ID"),
    instanceToken: required("NULLLAB_INSTANCE_TOKEN"),
    labId: required("NULLLAB_LAB_ID"),
    port: Number(required("NULLLAB_LAB_PORT")),
    bindHost,
    orchestratorInternalUrl: required("NULLLAB_ORCHESTRATOR_URL"),
    instanceDbPath: process.env.NULLLAB_INSTANCE_DB_PATH ?? ":memory:",
  };
}
