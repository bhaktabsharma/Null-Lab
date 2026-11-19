import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import type { ControlDb } from "../db.js";
import { THEME_PRESETS, type ThemeSettings } from "@nulllab/shared";

const ThemeBodySchema = z.object({
  preset: z.enum(THEME_PRESETS),
  customAccent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
});

export async function preferenceRoutes(app: FastifyInstance, db: ControlDb): Promise<void> {
  app.get("/api/preferences/theme", { preHandler: requireAuth }, async (req) => {
    const row = db.prepare(`SELECT theme_preset, theme_custom_accent FROM preferences WHERE user_id = ?`).get(req.user!.id) as
      | { theme_preset: string; theme_custom_accent: string | null }
      | undefined;
    const theme: ThemeSettings = {
      preset: (row?.theme_preset as ThemeSettings["preset"]) ?? "ice-cyan",
      customAccent: row?.theme_custom_accent ?? null,
    };
    return { theme };
  });

  app.put("/api/preferences/theme", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = ThemeBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid theme payload." });
    db.prepare(
      `INSERT INTO preferences (user_id, theme_preset, theme_custom_accent) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET theme_preset = excluded.theme_preset, theme_custom_accent = excluded.theme_custom_accent`,
    ).run(req.user!.id, parsed.data.preset, parsed.data.customAccent);
    return { theme: parsed.data };
  });
}
