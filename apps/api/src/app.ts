import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { ProcessRuntime, DockerRuntime, CONTROL_ALIAS, PortAllocator, type LabRuntime } from "@nulllab/orchestrator";
import { loadEnv, REPO_ROOT, type Env } from "./env.js";
import { openControlDb, type ControlDb } from "./db.js";
import { loadCatalog, type CatalogEntry } from "./labs/catalog.js";
import { registerAuth } from "./auth/plugin.js";
import { authRoutes } from "./auth/routes.js";
import { labRoutes } from "./labs/routes.js";
import { instanceRoutes } from "./instances/routes.js";
import { internalRoutes } from "./internal/routes.js";
import { progressRoutes } from "./progress/routes.js";
import { preferenceRoutes } from "./preferences/routes.js";
import { InstanceManager } from "./instances/service.js";
import { buildAllowedOrigins, registerOriginGuard } from "./security/origin-guard.js";

export interface NulllabApp {
  app: FastifyInstance;
  db: ControlDb;
  catalog: Map<string, CatalogEntry>;
  manager: InstanceManager;
  env: Env;
}

export interface BuildOptions {
  /** Override env values — used by tests (in-memory DB, tiny idle timeouts, etc). */
  envOverrides?: Partial<Env>;
}

export async function buildApp(opts: BuildOptions = {}): Promise<NulllabApp> {
  const env = loadEnv(opts.envOverrides ?? {});

  const db = openControlDb(env);
  const catalog = loadCatalog(db);

  const ports = new PortAllocator(env.LAB_PORT_RANGE_START, env.LAB_PORT_RANGE_END);

  let runtime: LabRuntime;
  let internalUrl: string;
  if (env.RUNTIME_MODE === "docker") {
    if (!env.NULLLAB_SELF_CONTAINER) {
      throw new Error(
        "[env] RUNTIME_MODE=docker requires NULLLAB_SELF_CONTAINER (the name of the container the control plane runs in). " +
          "Docker mode is only supported when the control plane runs under Docker Compose — see docs/docker-mode.md.",
      );
    }
    runtime = new DockerRuntime({
      repoRoot: REPO_ROOT,
      network: env.LAB_DOCKER_NETWORK,
      imagePrefix: env.LAB_DOCKER_IMAGE_PREFIX,
      imageTag: env.LAB_DOCKER_IMAGE_TAG,
      selfContainer: env.NULLLAB_SELF_CONTAINER,
    });
    // Lab containers are on an internal network and reach us by alias.
    internalUrl = env.LAB_ORCHESTRATOR_URL ?? `http://${CONTROL_ALIAS}:${env.API_PORT}`;
  } else {
    runtime = new ProcessRuntime(REPO_ROOT);
    internalUrl = env.LAB_ORCHESTRATOR_URL ?? `http://127.0.0.1:${env.API_PORT}`;
  }

  const manager = new InstanceManager(db, catalog, runtime, ports, env, internalUrl);
  await manager.reapStaleOnBoot();

  const app = Fastify({
    logger: process.env.NULLLAB_TEST_SILENT ? false : { level: process.env.LOG_LEVEL ?? "info" },
    trustProxy: false,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: env.API_RATE_LIMIT_MAX, timeWindow: "1 minute" });
  registerOriginGuard(app, buildAllowedOrigins(env.WEB_ORIGIN, env.API_PORT));

  await registerAuth(app, db);

  const cookieSecure = env.WEB_ORIGIN.startsWith("https://");
  await authRoutes(app, db, cookieSecure);
  await labRoutes(app, db, catalog);
  await instanceRoutes(app, manager, catalog, env);
  await internalRoutes(app, db, catalog);
  await progressRoutes(app, db, catalog);
  await preferenceRoutes(app, db);

  app.get("/healthz", async () => ({ ok: true, labs: catalog.size, runtime: runtime.mode }));

  app.get("/api/meta", async () => ({
    runtimeMode: runtime.mode,
    labCount: catalog.size,
  }));

  // If the frontend has been built (apps/web/dist), serve it from this same
  // process so a Docker/production deployment is a single service on one
  // port. In local development, this directory won't exist — use the Vite
  // dev server on :5173 instead, which proxies /api here.
  const webDist = path.join(REPO_ROOT, "apps", "web", "dist");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist, index: "index.html" });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api") || req.raw.url?.startsWith("/internal")) {
        reply.code(404).send({ error: "Not found." });
        return;
      }
      reply.sendFile("index.html"); // client-side routing fallback
    });
    console.log(`[server] serving built frontend from ${webDist}`);
  }

  return { app, db, catalog, manager, env };
}
