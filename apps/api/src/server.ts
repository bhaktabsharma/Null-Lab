import { buildApp } from "./app.js";
import { closeBrowser } from "./instances/admin-bot.js";

async function main(): Promise<void> {
  const { app, env, manager } = await buildApp();

  const sweepInterval = setInterval(() => {
    manager.sweepExpired().catch((err) => app.log.error({ err }, "expiry sweep failed"));
  }, 60_000);
  sweepInterval.unref();

  if (env.RUNTIME_MODE === "docker" && (env.API_HOST === "127.0.0.1" || env.API_HOST === "localhost")) {
    throw new Error(
      "RUNTIME_MODE=docker needs API_HOST=0.0.0.0 inside the control-plane container so lab containers can reach /internal routes " +
        "(Compose still publishes the port to host loopback only).",
    );
  }
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  console.log(`\n  NULLLAB control-plane API listening on http://${env.API_HOST}:${env.API_PORT}`);
  console.log(`  Runtime mode: ${env.RUNTIME_MODE}  (lab bind host: ${env.LAB_BIND_HOST})`);
  console.log(`  Web origin (CORS): ${env.WEB_ORIGIN}\n`);

  const shutdown = async (signal: string) => {
    console.log(`\n[server] received ${signal}, shutting down...`);
    clearInterval(sweepInterval);
    await manager.stopAll();
    await closeBrowser();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
