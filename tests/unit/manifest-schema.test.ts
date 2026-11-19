import { describe, expect, it } from "vitest";
import { LabManifestSchema } from "../../packages/shared/src/manifest.js";

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "example-lab",
    version: "1.0.0",
    title: "Example Lab",
    objective: "Do the thing.",
    family: "access-control",
    subcategory: "idor",
    difficulty: "beginner",
    tags: ["idor"],
    estimatedMinutes: 15,
    entry: { runtime: "node", script: "labs/access-control/example-lab/server.ts" },
    docker: { image: "nulllab-lab/example-lab", dockerfile: "runtime/compose/lab.Dockerfile" },
    verifier: { condition: "Something true happened.", requiresBrowserBot: false },
    ...overrides,
  };
}

describe("LabManifestSchema", () => {
  it("accepts a well-formed manifest and fills in defaults", () => {
    const result = LabManifestSchema.safeParse(validManifest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(["idor"]);
      expect(result.data.prerequisites).toEqual([]);
      expect(result.data.network.allowOutbound).toEqual([]);
      expect(result.data.resourceLimits.memoryMb).toBe(128);
    }
  });

  it("rejects an id that isn't kebab-case", () => {
    const result = LabManifestSchema.safeParse(validManifest({ id: "Example_Lab" }));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown vulnerability family", () => {
    const result = LabManifestSchema.safeParse(validManifest({ family: "not-a-real-family" }));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown difficulty", () => {
    const result = LabManifestSchema.safeParse(validManifest({ difficulty: "impossible" }));
    expect(result.success).toBe(false);
  });

  it("requires adminCookieName when requiresBrowserBot is true", () => {
    const missing = LabManifestSchema.safeParse(
      validManifest({ verifier: { condition: "x", requiresBrowserBot: true } }),
    );
    expect(missing.success).toBe(false);

    const present = LabManifestSchema.safeParse(
      validManifest({ verifier: { condition: "x", requiresBrowserBot: true, adminCookieName: "app_admin" } }),
    );
    expect(present.success).toBe(true);
  });

  it("rejects a missing docker.dockerfile (required for the Docker runtime path)", () => {
    const result = LabManifestSchema.safeParse(validManifest({ docker: { image: "nulllab-lab/example-lab" } }));
    expect(result.success).toBe(false);
  });
});
