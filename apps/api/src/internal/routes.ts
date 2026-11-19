import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlDb } from "../db.js";
import type { CatalogEntry } from "../labs/catalog.js";
import { newId } from "../util/ids.js";
import { XP_BY_DIFFICULTY } from "@nulllab/shared";

const SolveBodySchema = z.object({ evidence: z.string().min(1).max(2000) });
const EventBodySchema = z.object({ eventType: z.string().min(1).max(100), detail: z.record(z.string(), z.unknown()).default({}) });

interface InstanceRow {
  id: string;
  lab_id: string;
  user_id: string;
  status: string;
  instance_token: string;
}

/**
 * These routes are the verifier/orchestrator's internal surface. They are
 * reachable only with the per-instance secret token that NULLLAB generated
 * for that specific instance and handed only to that specific lab target
 * process (see lab-sdk/context.ts) — the browser, the frontend, and other
 * users never see it. This is what lets a lab target "self-report" a
 * genuinely-observed server-side solve without the control plane trusting
 * anything about *how* that condition was reached.
 *
 * In a Docker deployment, operators should additionally keep these routes
 * unpublished from the host and reachable only on the internal lab network
 * (see runtime/compose) — defense in depth on top of the token check,
 * never a replacement for it.
 */
export async function internalRoutes(app: FastifyInstance, db: ControlDb, catalog: Map<string, CatalogEntry>): Promise<void> {
  function authenticateInstance(instanceId: string, token: string | undefined): InstanceRow | null {
    if (!token) return null;
    const row = db.prepare(`SELECT * FROM lab_instances WHERE id = ?`).get(instanceId) as InstanceRow | undefined;
    if (!row) return null;
    // Constant-time-ish compare is nice-to-have here; length+content check is
    // sufficient since the token space is 256 bits and this isn't a login form.
    if (row.instance_token !== token) return null;
    return row;
  }

  app.post("/internal/instances/:instanceId/solve", async (req, reply) => {
    const { instanceId } = req.params as { instanceId: string };
    const token = req.headers["x-instance-token"] as string | undefined;
    const instance = authenticateInstance(instanceId, token);
    if (!instance) return reply.code(403).send({ error: "invalid instance token" });

    const parsed = SolveBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid solve payload" });

    const entry = catalog.get(instance.lab_id);
    if (!entry) return reply.code(500).send({ error: "lab manifest missing" });

    const now = new Date().toISOString();
    const alreadySolvedThisLab = db
      .prepare(`SELECT 1 FROM solves WHERE user_id = ? AND lab_id = ?`)
      .get(instance.user_id, instance.lab_id);

    let firstSolve = false;
    let xpAwarded = 0;
    if (!alreadySolvedThisLab) {
      const xp = XP_BY_DIFFICULTY[entry.manifest.difficulty];
      const info = db
        .prepare(
          `INSERT INTO solves (id, user_id, lab_id, instance_id, evidence, xp_awarded, verified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, lab_id) DO NOTHING`,
        )
        .run(newId(), instance.user_id, instance.lab_id, instance.id, parsed.data.evidence, xp, now);
      if (info.changes > 0) {
        firstSolve = true;
        xpAwarded = xp;
        db.prepare(`UPDATE users SET xp = xp + ? WHERE id = ?`).run(xp, instance.user_id);
      }
    }

    db.prepare(
      `INSERT INTO solve_attempts (id, instance_id, lab_id, user_id, evidence, resulted_in_award, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), instance.id, instance.lab_id, instance.user_id, parsed.data.evidence, firstSolve ? 1 : 0, now);

    db.prepare(`UPDATE lab_instances SET last_activity_at = ? WHERE id = ?`).run(now, instance.id);

    return { accepted: true, firstSolve, xpAwarded };
  });

  app.post("/internal/instances/:instanceId/event", async (req, reply) => {
    const { instanceId } = req.params as { instanceId: string };
    const token = req.headers["x-instance-token"] as string | undefined;
    const instance = authenticateInstance(instanceId, token);
    if (!instance) return reply.code(403).send({ error: "invalid instance token" });

    const parsed = EventBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid event payload" });

    db.prepare(
      `INSERT INTO instance_events (id, instance_id, event_type, detail_json, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(newId(), instance.id, parsed.data.eventType, JSON.stringify(parsed.data.detail), new Date().toISOString());
    db.prepare(`UPDATE lab_instances SET last_activity_at = ? WHERE id = ?`).run(new Date().toISOString(), instance.id);

    return { accepted: true };
  });
}
