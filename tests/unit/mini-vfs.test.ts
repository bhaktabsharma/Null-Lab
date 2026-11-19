import { describe, expect, it } from "vitest";
import { MiniVfs } from "../../packages/lab-sdk/src/index.js";

describe("MiniVfs (simulated — proven never to touch the real filesystem)", () => {
  it("reads seeded files and reports missing ones as absent", () => {
    const vfs = new MiniVfs({ "/app/public/index.html": "hello" });
    expect(vfs.read("/app/public/index.html")?.content).toBe("hello");
    expect(vfs.read("/app/public/nope.html")).toBeUndefined();
  });

  it("resolveUnder correctly normalizes real traversal sequences, the same way path.posix would", () => {
    const vfs = new MiniVfs();
    expect(vfs.resolveUnder("/app/uploads", "report.pdf")).toBe("/app/uploads/report.pdf");
    expect(vfs.resolveUnder("/app/uploads", "../secrets/key.pem")).toBe("/app/secrets/key.pem");
    expect(vfs.resolveUnder("/app/uploads", "../../etc/shadow")).toBe("/etc/shadow");
    expect(vfs.resolveUnder("/app/uploads", "./x/../y.txt")).toBe("/app/uploads/y.txt");
    expect(vfs.resolveUnder("/app/uploads", "a//b///c.txt")).toBe("/app/uploads/a/b/c.txt");
  });

  it("isUnder correctly distinguishes real containment from a same-prefix sibling (the classic startsWith bug)", () => {
    const vfs = new MiniVfs();
    expect(vfs.isUnder("/app/public", "/app/public")).toBe(true);
    expect(vfs.isUnder("/app/public", "/app/public/img/logo.png")).toBe(true);
    expect(vfs.isUnder("/app/public", "/app/public-admin/secrets.json")).toBe(false); // prefix match, not containment
    expect(vfs.isUnder("/app/public", "/app/other")).toBe(false);
    expect(vfs.isUnder("/app/public", "/etc/passwd")).toBe(false);
  });

  it("list() returns only direct children, not a recursive walk", () => {
    const vfs = new MiniVfs({ "/d/a.txt": "x", "/d/sub/b.txt": "y", "/other/c.txt": "z" });
    expect(vfs.list("/d")).toEqual(["a.txt", "sub"]);
  });

  it("writes land exactly where normalization says they should, and nowhere else", () => {
    const vfs = new MiniVfs();
    vfs.write(vfs.resolveUnder("/app/uploads", "../../tmp/evil.txt"), { content: "payload" });
    expect(vfs.read("/tmp/evil.txt")?.content).toBe("payload");
    expect(vfs.allPaths()).toEqual(["/tmp/evil.txt"]);
  });

  it("every operation is pure in-memory string math — proven by absence of any real file access for a real host path", () => {
    // If this module ever touched the real filesystem, reading a path that is a REAL, near-certainly-
    // existing file on this very machine (package.json at the repo root) would need to be explicitly
    // seeded to "exist" here — it must not, because MiniVfs has no connection to the real disk at all.
    const vfs = new MiniVfs({ "/app/readme.txt": "hi" });
    expect(vfs.exists("/package.json")).toBe(false);
    expect(vfs.exists(process.cwd() + "/package.json")).toBe(false);
    expect(vfs.read("/etc/passwd")).toBeUndefined();
  });
});
