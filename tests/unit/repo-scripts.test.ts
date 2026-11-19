import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the "fresh clone: `npm install && npm run dev` crashes
 * with ERR_MODULE_NOT_FOUND" bug.
 *
 * The API, the orchestrator and the test suites import the workspace packages
 * (@nulllab/shared, @nulllab/lab-sdk, @nulllab/orchestrator) through their
 * compiled `dist/` output, which does not exist after a plain `npm install`.
 *
 * The obvious fix — a `predev` / `pretest` hook — silently does nothing in this
 * repo: `.npmrc` sets `ignore-scripts=true` (needed so better-sqlite3 does not
 * trigger a node-gyp download), and npm does not run pre/post hooks when that
 * is set. So the build step has to be chained *inside* each entry-point script.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const npmrc = fs.readFileSync(path.join(ROOT, ".npmrc"), "utf8");

describe("root package.json scripts (fresh-clone workflow)", () => {
  it("defines build:libs, compiling the three workspace libraries in dependency order", () => {
    const s = pkg.scripts["build:libs"];
    expect(s, "build:libs script missing").toBeTruthy();
    const shared = s!.indexOf("packages/shared");
    const sdk = s!.indexOf("packages/lab-sdk");
    const orch = s!.indexOf("@nulllab/orchestrator");
    expect(shared).toBeGreaterThanOrEqual(0);
    expect(sdk).toBeGreaterThan(shared);
    expect(orch).toBeGreaterThan(sdk);
  });

  it.each(["dev", "build", "test:unit", "test:integration", "test:e2e", "test:proxy"])(
    "`npm run %s` builds the workspace libraries itself instead of assuming dist/ exists",
    (name) => {
      const s = pkg.scripts[name];
      expect(s, `script ${name} missing`).toBeTruthy();
      expect(s, `script ${name} must chain build:libs`).toContain("build:libs");
      // The build must come BEFORE the thing that imports the compiled output.
      expect(s!.indexOf("build:libs")).toBeLessThan(
        Math.max(s!.indexOf("concurrently"), s!.indexOf("vitest"), s!.indexOf("playwright"), s!.indexOf("build -w apps")),
      );
    },
  );

  it("does not rely on pre/post lifecycle hooks, which .npmrc's ignore-scripts=true silently disables", () => {
    const ignoresScripts = /^\s*ignore-scripts\s*=\s*true\s*$/m.test(npmrc);
    if (!ignoresScripts) return; // hooks would run; nothing to guard against
    const hooks = Object.keys(pkg.scripts).filter((k) => /^(pre|post)/.test(k) && pkg.scripts[k.replace(/^(pre|post)/, "")] !== undefined);
    expect(hooks, `these hooks would never run under ignore-scripts=true: ${hooks.join(", ")}`).toEqual([]);
  });
});

/**
 * `npm run typecheck` also type-checks tests/ and scripts/ (tsconfig.tests.json). It is a ratchet:
 * every file there is checked, except older files that already had errors when the check was
 * added. This guards that the check stays wired in and that the exclusion list cannot quietly grow.
 */
describe("tests/ and scripts/ type-check (ratchet)", () => {
  // The only files allowed to be excluded. Shrink by fixing a file; do not add to it.
  const LEGACY_EXCLUDES = ["tests/unit/instance-manager.test.ts"];
  const cfgText = fs.readFileSync(path.join(ROOT, "tsconfig.tests.json"), "utf8");
  const cfg = JSON.parse(cfgText.replace(/^\s*\/\/.*$/gm, "")) as { include: string[]; exclude: string[] };

  it("is part of `npm run typecheck`", () => {
    expect(pkg.scripts.typecheck).toContain("tsc -p tsconfig.tests.json");
  });

  it("covers every test and script file", () => {
    expect(cfg.include).toEqual(expect.arrayContaining(["tests/**/*.ts", "scripts/**/*.ts"]));
  });

  it("excludes no file beyond the known legacy ones (a new file must be fixed, not excluded)", () => {
    const extra = cfg.exclude.filter((f) => !LEGACY_EXCLUDES.includes(f));
    expect(extra, `new exclusions are not allowed: ${extra.join(", ")}`).toEqual([]);
  });

  it("has no stale exclusions (each excluded file still exists)", () => {
    for (const f of cfg.exclude) expect(fs.existsSync(path.join(ROOT, f)), `${f} no longer exists — remove it from tsconfig.tests.json`).toBe(true);
  });
});
