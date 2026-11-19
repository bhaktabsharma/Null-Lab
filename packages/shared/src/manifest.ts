import { z } from "zod";
import { ALL_FAMILY_IDS } from "./taxonomy.js";

export const DifficultySchema = z.enum(["beginner", "easy", "medium", "hard", "advanced"]);
export type Difficulty = z.infer<typeof DifficultySchema>;

/**
 * A lab manifest is the single source of truth for a lab scenario. The
 * catalogue, the orchestrator, and the automated tests all read this same
 * file — nothing about a lab is hardcoded into the frontend.
 */
export const LabManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "id must be kebab-case"),
  version: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  family: z.enum(ALL_FAMILY_IDS as [string, ...string[]]),
  subcategory: z.string().min(1),
  difficulty: DifficultySchema,
  tags: z.array(z.string()).default([]),
  estimatedMinutes: z.number().int().positive().default(20),
  prerequisites: z.array(z.string()).default([]),

  // Where the target's own entrypoint lives on disk, relative to the repo root.
  entry: z.object({
    runtime: z.literal("node"),
    /** Path to the compiled/executable entry script for the target app. */
    script: z.string().min(1),
  }),

  // Legacy per-lab image fields. The docker runtime now uses ONE shared lab
  // image and selects the lab by entry script, so new manifests omit this.
  docker: z
    .object({
      image: z.string().min(1),
      dockerfile: z.string().min(1),
    })
    .default({ image: "nulllab-lab:local", dockerfile: "runtime/compose/lab.Dockerfile" }),

  /**
   * The ONE weakness this lab teaches, in a sentence. Used to prove no two
   * labs are the same lab under different titles (the contract test requires
   * every lab to have one, unique across the catalogue).
   */
  weakness: z.string().min(10).optional(),
  /** Where the intended flaw lives, e.g. "POST /api/members/:id/delete". Shown to maintainers, never to learners. */
  vulnerableEndpoint: z.string().min(1).optional(),
  /** Plain description of the synthetic data seeded into every fresh instance. */
  seededData: z.string().min(1).optional(),
  /** Progressive, initially-hidden nudges. Must steer without revealing the exact exploit. */
  hints: z.array(z.string().min(1)).default([]),
  /**
   * Exact strings that would give the exploit away — a hidden path, a parameter
   * or cookie name, a payload fragment. The contract test fails if any appears in
   * anything always visible to a learner (title, objective, Burp notes, credential notes) or in any hint except the last — the final hint may be a last-resort nudge.
   */
  spoilers: z.array(z.string().min(2)).default([]),
  /** Tool-specific tips for working with this lab through Burp Suite / curl. */
  burpNotes: z.string().optional(),

  network: z.object({
    /** Lab targets are default-deny outbound; declare explicit exceptions. */
    allowOutbound: z.array(z.string()).default([]),
  }).default({ allowOutbound: [] }),

  resourceLimits: z
    .object({
      memoryMb: z.number().int().positive().default(128),
      cpus: z.number().positive().default(0.5),
    })
    .default({ memoryMb: 128, cpus: 0.5 }),

  verifier: z.object({
    /** Human-readable description of what proves the vulnerability was exploited. */
    condition: z.string().min(1),
    /** Whether this lab's proof requires a headless-browser "admin bot" visit (XSS-style labs). */
    requiresBrowserBot: z.boolean().default(false),
    /** Required when requiresBrowserBot is true: the lab's own admin-session cookie name. */
    adminCookieName: z.string().optional(),
  }),

  credentials: z
    .array(
      z.object({
        label: z.string(),
        username: z.string(),
        password: z.string(),
        note: z.string().optional(),
      }),
    )
    .default([]),

  solutionHint: z.string().optional(),
}).refine((m) => !m.verifier.requiresBrowserBot || !!m.verifier.adminCookieName, {
  message: "verifier.adminCookieName is required when verifier.requiresBrowserBot is true",
  path: ["verifier", "adminCookieName"],
});

export type LabManifest = z.infer<typeof LabManifestSchema>;

/**
 * What a LEARNER is allowed to see about a lab. The full manifest also holds
 * maintainer-facing fields — the verifier condition (which describes the
 * exploit in words), the intended vulnerable endpoint, the weakness summary,
 * and the hint text — and sending those with the lab would give the
 * challenge away. Hints are fetched one at a time, on demand; the debrief
 * appears only after the lab has been solved.
 */
export interface PublicLabManifest {
  id: string;
  version: string;
  title: string;
  objective: string;
  family: LabManifest["family"];
  subcategory: string;
  difficulty: Difficulty;
  tags: string[];
  estimatedMinutes: number;
  prerequisites: string[];
  verifier: { requiresBrowserBot: boolean };
  credentials: LabManifest["credentials"];
  burpNotes?: string;
  /** How many hints exist; their text is only served by the hints endpoint. */
  hintCount: number;
  /** Present only once the learner has solved the lab. */
  debrief?: { weakness?: string; whatWasVerified: string };
}

/** Ordered hints for a lab: the new `hints` list, or the legacy single `solutionHint`. */
export function hintsOf(m: Pick<LabManifest, "hints" | "solutionHint">): string[] {
  if (m.hints.length > 0) return m.hints;
  return m.solutionHint ? [m.solutionHint] : [];
}

export function toPublicManifest(m: LabManifest, opts: { solved: boolean }): PublicLabManifest {
  return {
    id: m.id,
    version: m.version,
    title: m.title,
    objective: m.objective,
    family: m.family,
    subcategory: m.subcategory,
    difficulty: m.difficulty,
    tags: m.tags,
    estimatedMinutes: m.estimatedMinutes,
    prerequisites: m.prerequisites,
    verifier: { requiresBrowserBot: m.verifier.requiresBrowserBot },
    credentials: m.credentials,
    ...(m.burpNotes ? { burpNotes: m.burpNotes } : {}),
    hintCount: hintsOf(m).length,
    ...(opts.solved ? { debrief: { ...(m.weakness ? { weakness: m.weakness } : {}), whatWasVerified: m.verifier.condition } } : {}),
  };
}
