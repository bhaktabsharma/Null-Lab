import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Cheap invariants on docs/lab-verification-status.json that need no test run.
 * (The claims themselves are checked against a real run by `npm run test:proxy`,
 * which ends with scripts/check-proxy-status.ts.)
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const status = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "lab-verification-status.json"), "utf8")) as Record<string, Record<string, unknown>>;

function manifests(): { id: string; browser: boolean }[] {
  const out: { id: string; browser: boolean }[] = [];
  const stack = [path.join(ROOT, "labs")];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === "manifest.json") {
        const m = JSON.parse(fs.readFileSync(full, "utf8"));
        out.push({ id: m.id, browser: m.verifier?.requiresBrowserBot === true });
      }
    }
  }
  return out;
}

describe("lab-verification-status.json", () => {
  const labs = manifests();

  it("has an entry for every lab and none for labs that do not exist", () => {
    const ids = new Set(labs.map((l) => l.id));
    const entries = Object.keys(status).filter((k) => !k.startsWith("_"));
    expect(entries.filter((k) => !ids.has(k))).toEqual([]);
    expect([...ids].filter((id) => !(id in status))).toEqual([]);
  });

  it("records verifiedViaProxy as an explicit boolean for every lab", () => {
    for (const l of labs) expect(typeof status[l.id]?.verifiedViaProxy, l.id).toBe("boolean");
  });

  it("never claims proxy verification for a lab triggered in a real browser", () => {
    for (const l of labs.filter((x) => x.browser)) expect(status[l.id]?.verifiedViaProxy, l.id).toBe(false);
  });

  it("only claims proxy verification where the lab is also recorded as tested and verified over raw HTTP", () => {
    for (const l of labs) {
      const s = status[l.id]!;
      if (s.verifiedViaProxy === true) {
        expect(s.testsPassing, l.id).toBe(true);
        expect(s.verifiedExternalClient, l.id).toBe(true);
      }
    }
  });
});
