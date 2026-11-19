import { describe, expect, it } from "vitest";
import { applyProven, evaluate, mergeReports, proxyVerdict, type LabProxyStats, type MergedLabStats, type ProxyReportFile } from "../../scripts/proxy-status-lib.js";

const stats = (o: Partial<LabProxyStats> = {}): LabProxyStats => ({ requests: 0, nonGetRequests: 0, tunnels: 0, solved: false, statuses: {}, ...o });
const merged1 = (o: Partial<MergedLabStats> = {}): MergedLabStats => ({ ...stats(), provenIn: [], ...o });
const report = (file: string, labs: Record<string, LabProxyStats>): ProxyReportFile => ({ file, blocked: 0, labs });

describe("proxy verification verdicts", () => {
  it("requires proxied traffic and a real solve in the SAME test file", () => {
    expect(proxyVerdict(merged1({ requests: 3, solved: true, provenIn: ["x.test.ts"] })).ok).toBe(true);
    expect(proxyVerdict(merged1({ tunnels: 1, solved: true, provenIn: ["ws.test.ts"] })).ok).toBe(true); // WebSocket via CONNECT
    expect(proxyVerdict(merged1({ requests: 0, tunnels: 0, solved: true })).reason).toBe("no traffic went through the proxy");
    expect(proxyVerdict(merged1({ requests: 9, solved: false })).reason).toContain("never solved");
    expect(proxyVerdict(undefined).ok).toBe(false);
  });

  it("does not accept traffic from one file plus a solve from another (the contract-test trap)", () => {
    const m = mergeReports([
      report("contract.test.ts", { lab: stats({ requests: 5 }) }), // probes only, never solved
      report("exploit.test.ts", { lab: stats({ requests: 0, solved: true }) }), // solved, but nothing went through the proxy
    ]);
    expect(m.lab!.requests).toBe(5);
    expect(m.lab!.solved).toBe(true);
    expect(m.lab!.provenIn).toEqual([]);
    expect(proxyVerdict(m.lab)).toEqual({ ok: false, reason: "solved in a test file where none of its traffic went through the proxy" });
  });

  it("never counts browser-triggered labs, even with traffic and a solve", () => {
    const v = proxyVerdict(merged1({ requests: 8, solved: true, provenIn: ["xss.test.ts"] }), { browserTriggered: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("not routed through the proxy");
  });

  it("merges reports from several test files (sums traffic, ORs solved, records proof files)", () => {
    const m = mergeReports([
      report("a.test.ts", { x: stats({ requests: 2, statuses: { "200": 2 } }), y: stats({ requests: 1, solved: true }) }),
      report("b.test.ts", { x: stats({ requests: 3, nonGetRequests: 1, solved: true, statuses: { "200": 1, "403": 2 } }) }),
    ]);
    expect(m.x).toEqual({ requests: 5, nonGetRequests: 1, tunnels: 0, solved: true, statuses: { "200": 3, "403": 2 }, provenIn: ["b.test.ts"] });
    expect(m.y!.provenIn).toEqual(["a.test.ts"]);
  });
});

describe("evaluate()", () => {
  const manifest = ["alpha", "beta", "gamma"];

  it("separates proven from not-proven with reasons, and flags claim mismatches both ways", () => {
    const merged = { alpha: merged1({ requests: 4, solved: true, provenIn: ["a.test.ts"] }), beta: merged1({ requests: 2 }), gamma: merged1({ solved: true }) };
    const ev = evaluate(manifest, merged, new Set(["beta", "alpha"]));
    expect(ev.proven).toEqual(["alpha"]);
    expect(ev.notProven.map((n) => n.id)).toEqual(["beta", "gamma"]);
    expect(ev.claimedNotProven).toEqual(["beta"]); // claimed but this run did not prove it
    expect(ev.provenNotClaimed).toEqual([]);
    expect(evaluate(manifest, merged, new Set()).provenNotClaimed).toEqual(["alpha"]);
  });

  it("excludes browser-triggered labs and retracts a claim made for one", () => {
    const merged = { alpha: merged1({ requests: 4, solved: true, provenIn: ["a.test.ts"] }), beta: merged1({ requests: 6, solved: true, provenIn: ["b.test.ts"] }), gamma: merged1() };
    const ev = evaluate(manifest, merged, new Set(["beta"]), new Set(["beta"]));
    expect(ev.proven).toEqual(["alpha"]);
    expect(ev.claimedNotProven).toEqual(["beta"]);
    expect(ev.notProven.find((n) => n.id === "beta")!.reason).toContain("browser");
  });

  it("detects a partial run (a manifest lab missing from every report) and stale lab ids", () => {
    const ev = evaluate(manifest, { alpha: merged1({ requests: 1, solved: true, provenIn: ["a"] }), ghost: merged1() }, new Set());
    expect(ev.missingFromReports).toEqual(["beta", "gamma"]);
    expect(ev.unknownInReports).toEqual(["ghost"]);
  });
});

describe("applyProven()", () => {
  it("sets verifiedViaProxy on every lab entry, true only for proven labs, keeping other fields and the _comment", () => {
    const before = {
      _comment: "keep me",
      alpha: { testsPassing: true, verifiedExternalClient: true, documented: true, testFile: "t.ts" },
      beta: { testsPassing: true, verifiedExternalClient: true, verifiedViaProxy: true, documented: true, testFile: "t.ts" },
    };
    const after = applyProven(before, new Set(["alpha"]));
    expect(after._comment).toBe("keep me");
    expect(after.alpha.verifiedViaProxy).toBe(true);
    expect(after.beta.verifiedViaProxy).toBe(false); // a stale claim is retracted
    expect(Object.keys(after.alpha)).toEqual(["testsPassing", "verifiedExternalClient", "verifiedViaProxy", "documented", "testFile"]);
    expect(after.alpha.testFile).toBe("t.ts");
  });
});
