import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The README states how many labs exist, per family and per difficulty. Those numbers were once
 * hand-typed and went stale ("20 working labs" while 80 existed). This fails the build whenever
 * the README disagrees with the manifests actually in the repository.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

interface M {
  family: string;
  difficulty: string;
}
function manifests(): M[] {
  const out: M[] = [];
  const stack = [path.join(ROOT, "labs")];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === "manifest.json") out.push(JSON.parse(fs.readFileSync(full, "utf8")));
    }
  }
  return out;
}

// README table label (prefix) -> family id
const ROW_TO_FAMILY: Record<string, string> = {
  "Access control": "access-control",
  Injection: "injection",
  "Authentication & session": "auth-session",
  "API security": "api-security",
  "Business logic & races": "server-logic",
  SSRF: "ssrf",
  "Client-side": "client-side",
  "File handling": "file-handling",
  Misconfiguration: "misconfiguration",
  "Modern platform": "modern-platform",
  "XML & parsers": "xml-parsers",
  "Information disclosure": "information-disclosure",
};

describe("README lab counts match the manifests", () => {
  const labs = manifests();

  it("states the total number of labs and of families", () => {
    const m = /\*\*(\d+) working labs\*\*\s+across (\d+) vulnerability families/.exec(readme);
    expect(m, "README no longer has the '**N working labs** across M vulnerability families' sentence").toBeTruthy();
    expect(Number(m![1])).toBe(labs.length);
    expect(Number(m![2])).toBe(new Set(labs.map((l) => l.family)).size);
  });

  it("states the difficulty mix", () => {
    const m = /Difficulty mix: (\d+) beginner,\s+(\d+) easy, (\d+) medium, (\d+) hard, (\d+) advanced/.exec(readme);
    expect(m, "README no longer has the difficulty-mix sentence").toBeTruthy();
    const count = (d: string) => labs.filter((l) => l.difficulty === d).length;
    expect(m!.slice(1, 6).map(Number)).toEqual(["beginner", "easy", "medium", "hard", "advanced"].map(count));
  });

  it("lists every family with the right number of labs", () => {
    const rows = [...readme.matchAll(/^\| ([^|]+?) \| (\d+) \|$/gm)].map((r) => ({ label: r[1]!, n: Number(r[2]) }));
    for (const [prefix, family] of Object.entries(ROW_TO_FAMILY)) {
      const row = rows.find((r) => r.label.startsWith(prefix));
      expect(row, `README table has no row for ${prefix}`).toBeTruthy();
      expect(row!.n, `README says ${row!.n} ${prefix} labs`).toBe(labs.filter((l) => l.family === family).length);
    }
    // a family added to the repo without a README row would otherwise slip through
    expect([...new Set(labs.map((l) => l.family))].sort()).toEqual(Object.values(ROW_TO_FAMILY).sort());
  });

  it("states how many labs are proxy-verified, matching the status file", () => {
    const status = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "lab-verification-status.json"), "utf8")) as Record<string, { verifiedViaProxy?: boolean }>;
    const flagged = Object.entries(status).filter(([k, v]) => !k.startsWith("_") && v.verifiedViaProxy === true).length;
    const m = /\*\*(\d+) of (\d+) labs\*\*/.exec(readme);
    expect(m, "README no longer has the '**N of M labs**' proxy-verification sentence").toBeTruthy();
    expect(Number(m![1])).toBe(flagged);
    expect(Number(m![2])).toBe(labs.length);
  });
});
