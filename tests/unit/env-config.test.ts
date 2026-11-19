import { describe, expect, it } from "vitest";
import { loadEnv } from "../../apps/api/src/env.js";

describe("loadEnv() configuration errors", () => {
  it("tells a fresh-clone user how to fix a missing SESSION_SECRET (copy .env.example)", () => {
    // An explicit undefined override hides any value that a local .env or the
    // shell would otherwise supply, so this test does not depend on the machine.
    let message = "";
    try {
      loadEnv({ SESSION_SECRET: undefined });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("SESSION_SECRET");
    expect(message).toContain("cp .env.example .env");
  });

  it("does not add the hint for unrelated configuration errors", () => {
    let message = "";
    try {
      loadEnv({ SESSION_SECRET: "x".repeat(40), API_PORT: "not-a-port" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("API_PORT");
    expect(message).not.toContain("cp .env.example");
  });

  it("accepts a valid configuration", () => {
    expect(loadEnv({ SESSION_SECRET: "x".repeat(40) }).API_PORT).toBeTypeOf("number");
  });
});
