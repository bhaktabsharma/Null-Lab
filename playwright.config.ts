import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const API_PORT = 4300;
const WEB_PORT = 5273;

function detectLocalChromium(): string | undefined {
  if (process.env.NULLLAB_CHROMIUM_EXECUTABLE) return process.env.NULLLAB_CHROMIUM_EXECUTABLE;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.HOME ?? "", ".cache/ms-playwright")].filter(
    (p): p is string => !!p,
  );
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter((d) => d.startsWith("chromium-"))) {
      const candidate = path.join(root, dir, "chrome-linux", "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const apiEnv = {
  API_PORT: String(API_PORT),
  API_HOST: "127.0.0.1",
  WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
  SESSION_SECRET: "e2e-test-session-secret-0123456789abcdef",
  DATABASE_PATH: ":memory:",
  RUNTIME_MODE: "process",
  LAB_PORT_RANGE_START: "5700",
  LAB_PORT_RANGE_END: "5799",
  NULLLAB_CHROMIUM_EXECUTABLE: detectLocalChromium() ?? "",
  NULLLAB_CHROMIUM_NO_SANDBOX: "true",
};

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    launchOptions: {
      executablePath: detectLocalChromium(),
      args: ["--no-sandbox"],
    },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npx tsx apps/api/src/server.ts",
      cwd: ".",
      env: apiEnv,
      port: API_PORT,
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: `npx vite --config apps/web/vite.config.ts --port ${WEB_PORT} --strictPort`,
      cwd: ".",
      env: { API_PORT: String(API_PORT) },
      port: WEB_PORT,
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
});
