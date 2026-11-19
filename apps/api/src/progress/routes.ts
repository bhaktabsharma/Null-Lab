import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/plugin.js";
import type { ControlDb } from "../db.js";
import type { CatalogEntry } from "../labs/catalog.js";
import { FAMILIES, type FamilyId } from "@nulllab/shared";

export async function progressRoutes(app: FastifyInstance, db: ControlDb, catalog: Map<string, CatalogEntry>): Promise<void> {
  app.get("/api/progress", { preHandler: requireAuth }, async (req) => {
    const user = db.prepare(`SELECT xp FROM users WHERE id = ?`).get(req.user!.id) as { xp: number };
    const solves = db
      .prepare(
        `SELECT lab_id, instance_id, evidence, xp_awarded, verified_at FROM solves WHERE user_id = ? ORDER BY verified_at DESC`,
      )
      .all(req.user!.id) as { lab_id: string; instance_id: string; evidence: string; xp_awarded: number; verified_at: string }[];

    const byFamily: Record<string, { total: number; solved: number }> = {};
    for (const familyId of Object.keys(FAMILIES) as FamilyId[]) {
      byFamily[familyId] = { total: 0, solved: 0 };
    }
    const solvedLabIds = new Set(solves.map((s) => s.lab_id));
    for (const { manifest } of catalog.values()) {
      const bucket = byFamily[manifest.family];
      if (!bucket) continue;
      bucket.total += 1;
      if (solvedLabIds.has(manifest.id)) bucket.solved += 1;
    }

    return {
      xp: user.xp,
      totalLabs: catalog.size,
      totalSolved: solvedLabIds.size,
      byFamily,
      recentSolves: solves.slice(0, 20).map((s) => ({
        labId: s.lab_id,
        labTitle: catalog.get(s.lab_id)?.manifest.title ?? s.lab_id,
        instanceId: s.instance_id,
        evidence: s.evidence,
        xpAwarded: s.xp_awarded,
        verifiedAt: s.verified_at,
      })),
    };
  });
}
