import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import type { InstanceManager } from "./service.js";
import type { CatalogEntry } from "../labs/catalog.js";
import type { Env } from "../env.js";
import { simulateAdminVisit } from "./admin-bot.js";

const SimulateVisitSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(2000)
    .regex(/^\/(?!\/)/, "path must be a relative path starting with a single /"),
});

export async function instanceRoutes(
  app: FastifyInstance,
  manager: InstanceManager,
  catalog: Map<string, CatalogEntry>,
  env: Env,
): Promise<void> {
  app.post("/api/labs/:labId/instances", { preHandler: requireAuth }, async (req, reply) => {
    const { labId } = req.params as { labId: string };
    const result = await manager.launch(req.user!.id, labId);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { instance: result.instance };
  });

  app.get("/api/instances", { preHandler: requireAuth }, async (req) => {
    const rows = manager.listForUser(req.user!.id);
    const instances = [];
    for (const row of rows) {
      const dto = await manager.getDTOForUser(req.user!.id, row.id);
      if (dto) instances.push(dto);
    }
    return { instances };
  });

  app.get("/api/instances/:instanceId", { preHandler: requireAuth }, async (req, reply) => {
    const { instanceId } = req.params as { instanceId: string };
    const dto = await manager.getDTOForUser(req.user!.id, instanceId);
    if (!dto) return reply.code(404).send({ error: "No such instance." });
    return { instance: dto };
  });

  app.post("/api/instances/:instanceId/reset", { preHandler: requireAuth }, async (req, reply) => {
    const { instanceId } = req.params as { instanceId: string };
    const owned = manager.getForUser(req.user!.id, instanceId);
    if (!owned) return reply.code(404).send({ error: "No such instance." });
    const result = await manager.reset(req.user!.id, instanceId);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { instance: result.instance };
  });

  app.post("/api/instances/:instanceId/stop", { preHandler: requireAuth }, async (req, reply) => {
    const { instanceId } = req.params as { instanceId: string };
    const owned = manager.getForUser(req.user!.id, instanceId);
    if (!owned) return reply.code(404).send({ error: "No such instance." });
    await manager.stop(instanceId);
    return { ok: true };
  });

  // For XSS-style labs: drives a real headless browser, authenticated as
  // the lab's simulated admin, to the path the person supplies — this is
  // what lets reflected/stored XSS be proven by actual script execution
  // rather than a reflected-string guess. See admin-bot.ts.
  app.post("/api/instances/:instanceId/simulate-admin-visit", { preHandler: requireAuth }, async (req, reply) => {
    const { instanceId } = req.params as { instanceId: string };
    const owned = manager.getForUser(req.user!.id, instanceId);
    if (!owned) return reply.code(404).send({ error: "No such instance." });
    if (owned.status !== "running" || !owned.base_url) {
      return reply.code(400).send({ error: "This lab instance isn't running." });
    }
    const entry = catalog.get(owned.lab_id);
    if (!entry) return reply.code(500).send({ error: "lab manifest missing" });
    if (!entry.manifest.verifier.requiresBrowserBot || !entry.manifest.verifier.adminCookieName) {
      return reply.code(400).send({ error: "This lab doesn't use the browser-bot verifier." });
    }

    const parsed = SimulateVisitSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid path." });

    const result = await simulateAdminVisit({
      env,
      targetBaseUrl: owned.base_url,
      instanceToken: owned.instance_token,
      path: parsed.data.path,
      adminCookieName: entry.manifest.verifier.adminCookieName,
    });
    manager.touch(instanceId);
    if (!result.ok) return reply.code(502).send({ error: result.error ?? "The admin bot visit failed." });
    return { ok: true };
  });
}
