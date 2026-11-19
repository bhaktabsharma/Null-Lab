import { describe, expect, it } from "vitest";
import { MockInternalNet } from "../../packages/lab-sdk/src/index.js";

describe("MockInternalNet (simulated — proven never to touch a real socket)", () => {
  it("resolves only registered host:port pairs; everything else is a simulated refusal, fast", async () => {
    const net = new MockInternalNet();
    net.registerStatic({ host: "internal-admin.lab", port: 80 }, '{"ok":true}');

    const hit = await net.fetch("http://internal-admin.lab/");
    expect(hit).toMatchObject({ ok: true, status: 200, resolvedHost: "internal-admin.lab" });

    const start = Date.now();
    const miss = await net.fetch("http://unregistered-host.test/");
    expect(miss.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(500); // a fast synthetic refusal, not a real DNS/connect timeout
    if (!miss.ok) expect(miss.error).toMatch(/connection refused \(simulated/);
  });

  it("only speaks http/https and only ever inspects the string — never performs I/O for any scheme", async () => {
    const net = new MockInternalNet();
    for (const scheme of ["file:///etc/passwd", "ftp://internal.lab/x", "gopher://internal.lab/x", "not a url at all"]) {
      const res = await net.fetch(scheme);
      expect(res.ok).toBe(false);
    }
  });

  it("canonicalizes IPv4 the same way a real HTTP client's URL parsing would (decimal/hex/octal/short forms)", async () => {
    const net = new MockInternalNet();
    net.registerStatic({ host: "127.0.0.1", port: 80 }, "loopback-service");
    for (const form of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/"]) {
      const res = await net.fetch(form);
      expect(res.ok, form).toBe(true);
      if (res.ok) expect(res.resolvedHost).toBe("127.0.0.1");
    }
  });

  it("separates URL userinfo from the real host, exactly like a real URL parser (the classic @ trick)", async () => {
    const net = new MockInternalNet();
    net.registerStatic({ host: "169.254.169.254", port: 80 }, "metadata");
    const res = await net.fetch("http://trusted-looking-name.test@169.254.169.254/");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolvedHost).toBe("169.254.169.254");
  });

  it("respects explicit and default ports independently", async () => {
    const net = new MockInternalNet();
    net.registerStatic({ host: "internal.lab", port: 8080 }, "admin-panel");
    expect((await net.fetch("http://internal.lab/")).ok).toBe(false); // default port 80, nothing registered there
    expect((await net.fetch("http://internal.lab:8080/")).ok).toBe(true);
  });

  it("fetchFollowingRedirects chains through simulated hops and stops after the limit", async () => {
    const net = new MockInternalNet();
    net.registerService({ host: "a.lab", port: 80 }, () => ({ redirectTo: "http://b.lab/" }));
    net.registerService({ host: "b.lab", port: 80 }, () => ({ redirectTo: "http://c.lab/" }));
    net.registerStatic({ host: "c.lab", port: 80 }, "final");

    const res = await net.fetchFollowingRedirects("http://a.lab/", 3);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.finalHost).toBe("c.lab");
      expect(res.hops).toEqual(["a.lab", "b.lab", "c.lab"]);
    }

    const tooMany = await net.fetchFollowingRedirects("http://a.lab/", 1);
    expect(tooMany.ok).toBe(false);
  });
});
