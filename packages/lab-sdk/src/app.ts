import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import querystring from "node:querystring";
import type { LabContext } from "./context.js";

export interface CreateLabAppOptions {
  /** Shown in the Fastify logger; purely cosmetic. */
  appName: string;
}

/**
 * Every lab target is its own small Fastify app. This factory gives each
 * one the same minimal, consistent foundation (cookie parsing, a /healthz
 * route the orchestrator polls during launch, quiet logging so instance
 * logs stay readable) without copy-pasting boilerplate into every one of
 * the many lab scenarios.
 */
export async function createLabApp(ctx: LabContext, opts: CreateLabAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NULLLAB_TEST_SILENT ? false : { level: "warn" },
    trustProxy: false,
  });

  await app.register(cookie);

  // Nearly every lab target has at least one plain HTML <form method="post">
  // login/search/comment box — register the standard parser once here.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, querystring.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/healthz", async () => ({ ok: true, lab: ctx.labId, instance: ctx.instanceId, app: opts.appName }));

  return app;
}

/** Starts listening and logs a single human-readable line for local debugging. */
export async function startLabApp(app: FastifyInstance, ctx: LabContext, appName: string): Promise<void> {
  await app.listen({ port: ctx.port, host: ctx.bindHost });
  console.log(`[${appName}] instance ${ctx.instanceId} listening on http://${ctx.bindHost}:${ctx.port}`);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}
