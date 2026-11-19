import { defineConfig } from "vitest/config";

/**
 * Runs the whole integration suite with every learner-side request to a lab
 * routed through the local forward proxy (tests/integration/proxy.ts). Used
 * by `npm run test:proxy`; the normal config is untouched.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: "default",
    fileParallelism: false,
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/integration/proxy-setup.ts"],
    env: { NULLLAB_TEST_PROXY: "1" },
  },
});
