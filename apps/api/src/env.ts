import { z } from "zod";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

// Repo root = three levels up from apps/api/src (apps/api/src -> apps/api -> apps -> repo root)
const thisFile = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(thisFile), "../../../");

/**
 * Loads a `.env` file from the repo root into process.env, without adding a
 * dependency. Real environment variables (e.g. ones set by Docker Compose
 * or a CI runner) always win over the file — this only fills in gaps.
 */
function loadDotEnv(repoRoot: string): void {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const EnvSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(4000),
  /** Requests per minute allowed per client on /api/*. See @fastify/rate-limit; 300/min is the production default. */
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  API_HOST: z.string().default("127.0.0.1"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  DATABASE_PATH: z.string().default("./data/control.db"),
  RUNTIME_MODE: z.enum(["process", "docker"]).default("process"),
  LAB_PORT_RANGE_START: z.coerce.number().int().default(5100),
  LAB_PORT_RANGE_END: z.coerce.number().int().default(5999),
  LAB_INSTANCE_IDLE_MINUTES: z.coerce.number().positive().default(30),
  LAB_INSTANCE_MAX_MINUTES: z.coerce.number().positive().default(120),
  LAB_DOCKER_NETWORK: z.string().default("nulllab_labnet"),
  LAB_DOCKER_IMAGE_PREFIX: z.string().default("nulllab-lab"),
  LAB_DOCKER_IMAGE_TAG: z.string().default("local"),

  /**
   * Interface lab targets listen on. 127.0.0.1 is right for a host-side
   * install. Inside the Compose container it must be 0.0.0.0 (a service on
   * the container's own loopback is unreachable through a published port);
   * Compose then publishes those ports to the HOST's loopback only.
   */
  LAB_BIND_HOST: z
    .string()
    .default("127.0.0.1")
    .refine((v) => isIP(v) !== 0, "LAB_BIND_HOST must be an IP address"),
  /** Override the URL lab targets use to call back into the control plane. */
  LAB_ORCHESTRATOR_URL: z.string().url().optional(),
  /** Docker mode only: the name of the container this control plane runs in. */
  NULLLAB_SELF_CONTAINER: z.string().optional(),

  // Advanced/optional: only needed if Playwright's own browser download
  // doesn't match what's actually installed on this machine.
  NULLLAB_CHROMIUM_EXECUTABLE: z.string().optional(),
  // z.coerce.boolean() would turn the string "false" into true; parse it explicitly.
  NULLLAB_CHROMIUM_NO_SANDBOX: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === "true" || v === "1"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  loadDotEnv(REPO_ROOT);
  // Overrides are merged in BEFORE validation, not after — callers (tests,
  // primarily) can supply required fields like SESSION_SECRET directly
  // without depending on a .env file existing on disk at all.
  const merged = { ...process.env, ...overrides };
  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => ` - ${i.path.join(".")}: ${i.message}`).join("\n");
    // The by-far most common cause on a fresh clone: the documented
    // `cp .env.example .env` step was skipped, so the web dev server starts but
    // the API exits. Say how to fix it instead of only naming the field.
    const missingSecret = parsed.error.issues.some((i) => i.path[0] === "SESSION_SECRET");
    const hint = missingSecret
      ? "\nHint: SESSION_SECRET is not set. On a fresh clone run `cp .env.example .env` (any local random string is fine for local practice), then start NULLLAB again."
      : "";
    throw new Error("[env] invalid configuration:\n" + lines + hint);
  }
  return parsed.data;
}
