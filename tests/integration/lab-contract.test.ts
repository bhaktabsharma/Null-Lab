import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, CookieClient, type TestApp } from "./helpers.js";
import { launch, newLearner } from "./lab-harness.js";
import { FAMILIES, LabManifestSchema, hintsOf, type LabManifest } from "../../packages/shared/src/index.js";

/**
 * The lab contract — applied to EVERY lab in the catalogue, old and new, so a
 * lab can't ship without the basics. Lab-specific exploit tests live beside
 * their batch; this file proves what must be true of any lab:
 *   - its manifest is valid, complete, unique, and consistent with the repo;
 *   - the learner-facing API does not reveal how to solve it;
 *   - it launches healthy, starts unsolved, resets to a fresh instance, and
 *     stops cleanly.
 */
const REPO = path.resolve(import.meta.dirname, "../..");

function loadAll(): { dir: string; manifest: LabManifest }[] {
  const out: { dir: string; manifest: LabManifest }[] = [];
  for (const family of fs.readdirSync(path.join(REPO, "labs"), { withFileTypes: true })) {
    if (!family.isDirectory()) continue;
    for (const lab of fs.readdirSync(path.join(REPO, "labs", family.name), { withFileTypes: true })) {
      const file = path.join(REPO, "labs", family.name, lab.name, "manifest.json");
      if (!lab.isDirectory() || !fs.existsSync(file)) continue;
      out.push({ dir: `${family.name}/${lab.name}`, manifest: LabManifestSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) });
    }
  }
  return out;
}
const LABS = loadAll();

describe("lab manifests (static contract)", () => {
  it("finds the labs", () => {
    expect(LABS.length).toBeGreaterThanOrEqual(20);
  });

  it("ids are unique and match their directory; entry scripts exist", () => {
    const ids = LABS.map((l) => l.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { dir, manifest } of LABS) {
      expect(dir.split("/")[1], `${manifest.id}: id must equal directory name`).toBe(manifest.id);
      expect(fs.existsSync(path.join(REPO, manifest.entry.script)), `${manifest.id}: entry script`).toBe(true);
      expect(manifest.entry.script).toBe(`labs/${dir}/server.ts`);
    }
  });

  it("every lab sits in its family's folder and uses a known subcategory", () => {
    for (const { dir, manifest } of LABS) {
      expect(dir.split("/")[0], `${manifest.id}: folder vs family`).toBe(manifest.family);
      expect(FAMILIES[manifest.family as keyof typeof FAMILIES].subcategories, `${manifest.id}: subcategory "${manifest.subcategory}"`).toContain(manifest.subcategory);
    }
  });

  it("every lab documents its weakness, endpoint and seed data, and no two labs teach the same weakness", () => {
    const seen = new Map<string, string>();
    for (const { manifest } of LABS) {
      expect(manifest.weakness, `${manifest.id}: weakness`).toBeTruthy();
      expect(manifest.vulnerableEndpoint, `${manifest.id}: vulnerableEndpoint`).toBeTruthy();
      expect(manifest.seededData, `${manifest.id}: seededData`).toBeTruthy();
      expect(manifest.tags.length, `${manifest.id}: tags`).toBeGreaterThan(0);
      expect(manifest.verifier.condition.length, `${manifest.id}: verifier.condition`).toBeGreaterThan(20);
      const key = manifest.weakness!.toLowerCase();
      expect(seen.get(key), `${manifest.id} duplicates the weakness of ${seen.get(key)}`).toBeUndefined();
      seen.set(key, manifest.id);
    }
  });

  it("every lab has a hint and declares spoilers; learner-visible text only reveals them in the final hint", () => {
    for (const { manifest } of LABS) {
      const hints = hintsOf(manifest);
      expect(hints.length, `${manifest.id}: needs a hint`).toBeGreaterThan(0);
      expect(manifest.spoilers.length, `${manifest.id}: must declare spoilers`).toBeGreaterThan(0);

      // Always visible, no matter what the learner clicks: strictly spoiler-free.
      const alwaysVisible = [manifest.title, manifest.objective, manifest.burpNotes ?? "", ...manifest.credentials.map((c) => c.note ?? "")].join("\n").toLowerCase();
      // Hints are progressive: every hint EXCEPT the last (a last-resort nudge) must be spoiler-free too.
      const earlyHints = hints.slice(0, -1).join("\n").toLowerCase();
      for (const spoiler of manifest.spoilers) {
        const sp = spoiler.toLowerCase();
        expect(alwaysVisible.includes(sp), `${manifest.id}: always-visible text contains spoiler "${spoiler}"`).toBe(false);
        expect(earlyHints.includes(sp), `${manifest.id}: a non-final hint contains spoiler "${spoiler}"`).toBe(false);
      }
    }
  });

  it("prerequisites refer to labs that exist", () => {
    const ids = new Set(LABS.map((l) => l.manifest.id));
    for (const { manifest } of LABS) for (const p of manifest.prerequisites) expect(ids.has(p), `${manifest.id}: prerequisite ${p}`).toBe(true);
  });
});

describe("every lab at runtime", () => {
  let t: TestApp;
  beforeAll(async () => {
    // This file alone exercises every lab in the catalogue and so makes far more
    // /api requests per minute than any real learner session would; it gets its
    // own generous budget rather than weakening the 300/min production default.
    t = await startTestApp({ apiPort: 4131, labPortStart: 6800, labPortEnd: 6860, envOverrides: { API_RATE_LIMIT_MAX: 5000 } });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  for (const { manifest } of LABS) {
    it(`${manifest.id}: launches healthy, starts unsolved, does not leak its solution, resets, and stops cleanly`, async () => {
      const cp = await newLearner(t);
      const lab = await launch(t, manifest.id, cp);

      // reachable and healthy
      expect((await fetch(`${lab.baseUrl}/healthz`)).status).toBe(200);
      // an unauthenticated visit to the root never crashes the target
      expect((await fetch(lab.baseUrl, { redirect: "manual" })).status).toBeLessThan(500);

      // unsolved, with the manifest's credentials presented
      const inst = (await cp.json<{ instance: { solved: boolean; credentials: unknown[] } }>(`/api/instances/${lab.id}`)).body.instance;
      expect(inst.solved).toBe(false);
      expect(inst.credentials).toEqual(manifest.credentials);

      // the learner-facing lab payload must not give the exploit away
      const detailText = JSON.stringify((await cp.json(`/api/labs/${manifest.id}`)).body);
      const secrets = [manifest.verifier.condition, manifest.vulnerableEndpoint!, manifest.weakness!, manifest.seededData!, ...hintsOf(manifest)];
      for (const secret of secrets) expect(detailText.includes(secret), `payload leaks: ${secret.slice(0, 60)}`).toBe(false);
      expect(detailText).not.toContain("debrief");
      expect((await cp.json<{ manifest: { hintCount: number } }>(`/api/labs/${manifest.id}`)).body.manifest.hintCount).toBe(hintsOf(manifest).length);

      // hints come one at a time, in order, on request
      const all = hintsOf(manifest);
      for (let i = 1; i <= all.length; i++) {
        const h = await cp.json<{ hint: string; index: number; total: number }>(`/api/labs/${manifest.id}/hints/${i}`);
        expect(h.status).toBe(200);
        expect(h.body.hint).toBe(all[i - 1]);
        expect(h.body.total).toBe(all.length);
      }
      expect((await cp.json(`/api/labs/${manifest.id}/hints/${all.length + 1}`)).status).toBe(404);
      expect((await cp.json(`/api/labs/${manifest.id}/hints/0`)).status).toBe(404);
      expect((await new CookieClient(t.baseUrl).json(`/api/labs/${manifest.id}/hints/1`)).status).toBe(401);

      // reset → a different, unsolved instance
      const reset = await cp.json<{ instance: { id: string; baseUrl: string; solved: boolean } }>(`/api/instances/${lab.id}/reset`, { method: "POST" });
      expect(reset.status).toBe(200);
      expect(reset.body.instance.id).not.toBe(lab.id);
      expect(reset.body.instance.solved).toBe(false);
      expect((await fetch(`${reset.body.instance.baseUrl}/healthz`)).status).toBe(200);

      // stop → gone
      expect((await cp.fetch(`/api/instances/${reset.body.instance.id}/stop`, { method: "POST" })).status).toBe(200);
      await expect(fetch(`${reset.body.instance.baseUrl}/healthz`, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    }, 40_000);
  }
});

describe("debrief is withheld until the lab is solved", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4132, labPortStart: 6870, labPortEnd: 6880 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("shows weakness and the verified condition only after a real solve", async () => {
    const cp = await newLearner(t);
    const lab = await launch(t, "ac-forced-browsing", cp);
    const before = await cp.json<{ manifest: { debrief?: unknown } }>("/api/labs/ac-forced-browsing");
    expect(before.body.manifest.debrief).toBeUndefined();

    await lab.browser().fetch("/staff-tools-4821/payroll-export"); // the exploit
    const after = await cp.json<{ manifest: { debrief?: { weakness?: string; whatWasVerified: string } } }>("/api/labs/ac-forced-browsing");
    expect(after.body.manifest.debrief?.whatWasVerified).toContain("payroll export");
    expect(after.body.manifest.debrief?.weakness).toContain("unlinked");
    await lab.stop();
  });
});
