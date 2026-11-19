import path from "node:path";
import fs from "node:fs";
import type { LabRuntime, PortAllocator } from "@nulllab/orchestrator";
import type { LabInstanceDTO, InstanceStatus } from "@nulllab/shared";
import type { ControlDb } from "../db.js";
import type { CatalogEntry } from "../labs/catalog.js";
import { newId, newToken } from "../util/ids.js";
import { REPO_ROOT, type Env } from "../env.js";

interface InstanceRow {
  id: string;
  lab_id: string;
  user_id: string;
  status: InstanceStatus;
  port: number | null;
  base_url: string | null;
  instance_token: string;
  pid: number | null;
  db_path: string | null;
  created_at: string;
  expires_at: string;
  last_activity_at: string;
}

export class InstanceManager {
  constructor(
    private readonly db: ControlDb,
    private readonly catalog: Map<string, CatalogEntry>,
    private readonly runtime: LabRuntime,
    private readonly ports: PortAllocator,
    private readonly env: Env,
    private readonly internalUrl: string,
  ) {}

  /**
   * On boot, any instance left "running"/"starting" from before a restart
   * has no tracked process behind it — but the process/container itself may
   * well still be alive (control plane crashed or was SIGKILLed). Kill those
   * leftovers first, then mark the rows stopped, so a stale target can never
   * keep serving after the control plane has forgotten about it.
   */
  async reapStaleOnBoot(): Promise<void> {
    const stale = this.db
      .prepare(`SELECT * FROM lab_instances WHERE status IN ('running', 'starting')`)
      .all() as InstanceRow[];
    let killed = 0;
    try {
      killed = await this.runtime.reapOrphans(stale.map((r) => ({ instanceId: r.id, pid: r.pid })));
    } catch (err) {
      console.warn(`[instances] orphan cleanup failed: ${(err as Error).message}`);
    }
    const mark = this.db.prepare(`UPDATE lab_instances SET status = 'stopped' WHERE id = ?`);
    for (const row of stale) {
      mark.run(row.id);
      this.removeInstanceDb(row.db_path);
      this.logEvent(row.id, "reaped_on_boot", { previousStatus: row.status });
    }
    if (stale.length || killed) {
      console.log(`[instances] reaped ${stale.length} stale instance row(s) and ${killed} leftover target(s) from a previous run`);
    }
  }

  async launch(userId: string, labId: string): Promise<{ ok: true; instance: LabInstanceDTO } | { ok: false; error: string }> {
    const entry = this.catalog.get(labId);
    if (!entry) return { ok: false, error: "No such lab." };

    // One active instance per user per lab keeps resource usage bounded and
    // avoids orphaned instances piling up silently.
    const existing = this.db
      .prepare(
        `SELECT * FROM lab_instances WHERE user_id = ? AND lab_id = ? AND status IN ('starting','running') ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, labId) as InstanceRow | undefined;
    if (existing) return { ok: true, instance: await this.toDTO(existing, entry) };

    const instanceId = newId();
    const instanceToken = newToken(32);
    const now = new Date();
    const maxMs = this.env.LAB_INSTANCE_MAX_MINUTES * 60_000;
    const expiresAt = new Date(now.getTime() + maxMs).toISOString();

    this.db
      .prepare(
        `INSERT INTO lab_instances (id, lab_id, user_id, status, port, base_url, instance_token, pid, db_path, created_at, expires_at, last_activity_at)
         VALUES (?, ?, ?, 'starting', NULL, NULL, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(instanceId, labId, userId, instanceToken, now.toISOString(), expiresAt, now.toISOString());
    this.logEvent(instanceId, "launch_requested", { labId });

    let port: number | null = null;
    try {
      port = await this.ports.allocate();
      const dbDir = path.join(REPO_ROOT, "data", "instances");
      fs.mkdirSync(dbDir, { recursive: true });
      const instanceDbPath = path.join(dbDir, `${instanceId}.db`);
      const entryScript = path.join(REPO_ROOT, entry.manifest.entry.script);

      const spawnResult = await this.runtime.spawn({
        instanceId,
        instanceToken,
        labId,
        entryScript,
        port,
        bindHost: this.env.LAB_BIND_HOST,
        orchestratorInternalUrl: this.internalUrl,
        instanceDbPath,
        resourceLimits: entry.manifest.resourceLimits,
        allowOutbound: entry.manifest.network.allowOutbound,
      });

      const healthy = await this.runtime.waitHealthy(spawnResult.healthUrl, undefined, instanceId);
      if (!healthy) {
        const detail = this.runtime.lastError(instanceId);
        await this.abortLaunch(instanceId, port, instanceDbPath);
        this.logEvent(instanceId, "launch_failed", { reason: "health check failed", detail });
        return {
          ok: false,
          error: `The lab target didn't become healthy${detail ? `: ${detail.slice(0, 300)}` : " in time"}. Check the server logs and try again.`,
        };
      }

      this.db
        .prepare(
          `UPDATE lab_instances SET status = 'running', port = ?, base_url = ?, pid = ?, db_path = ?, last_activity_at = ? WHERE id = ?`,
        )
        .run(port, spawnResult.baseUrl, spawnResult.pid, instanceDbPath, new Date().toISOString(), instanceId);
      this.logEvent(instanceId, "launch_succeeded", { baseUrl: spawnResult.baseUrl });

      const row = this.db.prepare(`SELECT * FROM lab_instances WHERE id = ?`).get(instanceId) as InstanceRow;
      return { ok: true, instance: await this.toDTO(row, entry) };
    } catch (err) {
      // Never leave a half-started target or a leaked port behind.
      await this.abortLaunch(instanceId, port, null);
      this.logEvent(instanceId, "launch_failed", { reason: (err as Error).message });
      return { ok: false, error: `Failed to launch lab: ${(err as Error).message}` };
    }
  }

  private async abortLaunch(instanceId: string, port: number | null, dbPath: string | null): Promise<void> {
    await this.runtime.stop(instanceId).catch(() => undefined);
    if (port !== null) this.ports.release(port);
    this.removeInstanceDb(dbPath);
    this.db.prepare(`UPDATE lab_instances SET status = 'error' WHERE id = ?`).run(instanceId);
  }

  /** Deletes a per-instance SQLite file (and its WAL/SHM siblings). Best effort. */
  private removeInstanceDb(dbPath: string | null): void {
    if (!dbPath) return;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        /* not there */
      }
    }
  }

  async stop(instanceId: string): Promise<void> {
    const row = this.db.prepare(`SELECT * FROM lab_instances WHERE id = ?`).get(instanceId) as InstanceRow | undefined;
    if (!row) return;
    await this.runtime.stop(instanceId);
    if (row.port) this.ports.release(row.port);
    // A stopped instance is never restarted (launch always creates a fresh
    // one), so its data file is garbage — delete it rather than leak it.
    this.removeInstanceDb(row.db_path);
    this.db.prepare(`UPDATE lab_instances SET status = 'stopped' WHERE id = ?`).run(instanceId);
    this.logEvent(instanceId, "stopped", {});
  }

  async reset(userId: string, instanceId: string): Promise<{ ok: true; instance: LabInstanceDTO } | { ok: false; error: string }> {
    const row = this.db.prepare(`SELECT * FROM lab_instances WHERE id = ?`).get(instanceId) as InstanceRow | undefined;
    if (!row || row.user_id !== userId) return { ok: false, error: "No such instance." };
    const entry = this.catalog.get(row.lab_id);
    if (!entry) return { ok: false, error: "No such lab." };

    // stop() kills the old target and deletes its per-instance database, so
    // the relaunched instance starts from a genuinely clean state.
    await this.stop(instanceId);
    this.db.prepare(`DELETE FROM lab_instances WHERE id = ?`).run(instanceId);
    this.logEvent(instanceId, "reset", {});
    return this.launch(userId, row.lab_id);
  }

  getForUser(userId: string, instanceId: string): InstanceRow | null {
    const row = this.db.prepare(`SELECT * FROM lab_instances WHERE id = ?`).get(instanceId) as InstanceRow | undefined;
    if (!row || row.user_id !== userId) return null;
    return row;
  }

  async getDTOForUser(userId: string, instanceId: string): Promise<LabInstanceDTO | null> {
    const row = this.getForUser(userId, instanceId);
    if (!row) return null;
    const entry = this.catalog.get(row.lab_id);
    if (!entry) return null;
    // Don't report "running" for a target whose process/container died.
    if (row.status === "running" && !(await this.runtime.isAlive(instanceId))) {
      const detail = this.runtime.lastError(instanceId);
      await this.abortLaunch(instanceId, row.port, row.db_path);
      this.logEvent(instanceId, "died", { detail });
      row.status = "error";
      return this.toDTO(row, entry);
    }
    this.touch(instanceId);
    return this.toDTO(row, entry);
  }

  listForUser(userId: string): InstanceRow[] {
    return this.db
      .prepare(`SELECT * FROM lab_instances WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as InstanceRow[];
  }

  touch(instanceId: string): void {
    this.db
      .prepare(`UPDATE lab_instances SET last_activity_at = ? WHERE id = ? AND status = 'running'`)
      .run(new Date().toISOString(), instanceId);
  }

  /** Stops every currently running/starting instance, regardless of owner — used on shutdown and in tests. */
  async stopAll(): Promise<void> {
    const rows = this.db.prepare(`SELECT * FROM lab_instances WHERE status IN ('running','starting')`).all() as InstanceRow[];
    for (const row of rows) {
      await this.stop(row.id);
    }
  }

  /** Called by the background sweep: stop anything idle too long or past its hard lifetime. */
  async sweepExpired(): Promise<number> {
    const now = Date.now();
    const idleMs = this.env.LAB_INSTANCE_IDLE_MINUTES * 60_000;
    const running = this.db.prepare(`SELECT * FROM lab_instances WHERE status = 'running'`).all() as InstanceRow[];
    let stopped = 0;
    for (const row of running) {
      const expired = now > new Date(row.expires_at).getTime();
      const idle = now - new Date(row.last_activity_at).getTime() > idleMs;
      if (expired || idle) {
        await this.stop(row.id);
        this.db.prepare(`UPDATE lab_instances SET status = 'expired' WHERE id = ?`).run(row.id);
        this.logEvent(row.id, "expired", { reason: expired ? "max_lifetime" : "idle_timeout" });
        stopped++;
      }
    }
    return stopped;
  }

  logEvent(instanceId: string, eventType: string, detail: Record<string, unknown>): void {
    this.db
      .prepare(`INSERT INTO instance_events (id, instance_id, event_type, detail_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(newId(), instanceId, eventType, JSON.stringify(detail), new Date().toISOString());
  }

  private async toDTO(row: InstanceRow, entry: CatalogEntry): Promise<LabInstanceDTO> {
    const solved = !!this.db
      .prepare(`SELECT 1 FROM solves WHERE instance_id = ? LIMIT 1`)
      .get(row.id);
    return {
      id: row.id,
      labId: row.lab_id,
      status: row.status,
      baseUrl: row.base_url,
      credentials: entry.manifest.credentials,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastActivityAt: row.last_activity_at,
      solved,
    };
  }
}
