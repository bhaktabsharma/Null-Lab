import type { FastifyInstance } from "fastify";
import type { ControlDb } from "../db.js";
import type { CatalogEntry } from "./catalog.js";
import { requireAuth } from "../auth/plugin.js";
import { hintsOf, toPublicManifest, type LabSummaryDTO } from "@nulllab/shared";

export async function labRoutes(app: FastifyInstance, db: ControlDb, catalog: Map<string, CatalogEntry>): Promise<void> {
  app.get("/api/labs", { preHandler: requireAuth }, async (req) => {
    const solvedRows = db.prepare(`SELECT lab_id, verified_at FROM solves WHERE user_id = ?`).all(req.user!.id) as {
      lab_id: string;
      verified_at: string;
    }[];
    const solvedMap = new Map(solvedRows.map((r) => [r.lab_id, r.verified_at]));
    const savedRows = db.prepare(`SELECT lab_id FROM saved_labs WHERE user_id = ?`).all(req.user!.id) as { lab_id: string }[];
    const savedSet = new Set(savedRows.map((r) => r.lab_id));

    const list: LabSummaryDTO[] = [...catalog.values()]
      .map(({ manifest }) => ({
        id: manifest.id,
        title: manifest.title,
        objective: manifest.objective,
        family: manifest.family as LabSummaryDTO["family"],
        subcategory: manifest.subcategory,
        difficulty: manifest.difficulty,
        tags: manifest.tags,
        estimatedMinutes: manifest.estimatedMinutes,
        solved: solvedMap.has(manifest.id),
        saved: savedSet.has(manifest.id),
        solvedAt: solvedMap.get(manifest.id) ?? null,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));

    return { labs: list };
  });

  app.get("/api/labs/:labId", { preHandler: requireAuth }, async (req, reply) => {
    const { labId } = req.params as { labId: string };
    const entry = catalog.get(labId);
    if (!entry) return reply.code(404).send({ error: "No such lab." });
    const solved = db.prepare(`SELECT verified_at FROM solves WHERE user_id = ? AND lab_id = ?`).get(req.user!.id, labId) as
      | { verified_at: string }
      | undefined;
    const saved = !!db.prepare(`SELECT 1 FROM saved_labs WHERE user_id = ? AND lab_id = ?`).get(req.user!.id, labId);
    return {
      // Learner-facing projection only — never the full manifest (see PublicLabManifest).
      manifest: toPublicManifest(entry.manifest, { solved: !!solved }),
      solved: !!solved,
      solvedAt: solved?.verified_at ?? null,
      saved,
    };
  });

  // Hints are served one at a time, on request, so the full set is never sent with the lab.
  app.get("/api/labs/:labId/hints/:n", { preHandler: requireAuth }, async (req, reply) => {
    const { labId, n } = req.params as { labId: string; n: string };
    const entry = catalog.get(labId);
    if (!entry) return reply.code(404).send({ error: "No such lab." });
    const hints = hintsOf(entry.manifest);
    const index = Number(n);
    if (!Number.isInteger(index) || index < 1 || index > hints.length) return reply.code(404).send({ error: "No such hint." });
    return { index, total: hints.length, hint: hints[index - 1] };
  });

  app.post("/api/labs/:labId/save", { preHandler: requireAuth }, async (req, reply) => {
    const { labId } = req.params as { labId: string };
    if (!catalog.has(labId)) return reply.code(404).send({ error: "No such lab." });
    db.prepare(`INSERT OR IGNORE INTO saved_labs (user_id, lab_id, created_at) VALUES (?, ?, ?)`).run(
      req.user!.id,
      labId,
      new Date().toISOString(),
    );
    return { ok: true };
  });

  app.delete("/api/labs/:labId/save", { preHandler: requireAuth }, async (req) => {
    const { labId } = req.params as { labId: string };
    db.prepare(`DELETE FROM saved_labs WHERE user_id = ? AND lab_id = ?`).run(req.user!.id, labId);
    return { ok: true };
  });
}
