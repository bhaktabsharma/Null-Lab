/**
 * Pure logic behind `npm run test:proxy` / `npm run proxy:status`: turns the
 * per-test-file proxy reports (written by tests/integration/proxy-setup.ts) into a
 * verdict per lab, and compares it with what docs/lab-verification-status.json
 * claims. Kept free of I/O so tests/unit/proxy-status.test.ts can cover it.
 */

export interface LabProxyStats {
  requests: number;
  nonGetRequests: number;
  tunnels: number;
  solved: boolean;
  statuses: Record<string, number>;
}

/** Merged view of one lab across all report files. */
export interface MergedLabStats extends LabProxyStats {
  /**
   * Test files in which this lab was BOTH solved (per the control plane's own verifier) AND
   * had learner traffic going through the proxy. Proof has to come from a single run:
   * traffic in one file plus a solve in another proves nothing.
   */
  provenIn: string[];
}

export interface ProxyReportFile {
  file: string;
  blocked: number;
  labs: Record<string, LabProxyStats>;
}

export function mergeReports(files: ProxyReportFile[]): Record<string, MergedLabStats> {
  const out: Record<string, MergedLabStats> = {};
  for (const f of files) {
    for (const [id, s] of Object.entries(f.labs)) {
      const m = (out[id] ??= { requests: 0, nonGetRequests: 0, tunnels: 0, solved: false, statuses: {}, provenIn: [] });
      m.requests += s.requests;
      m.nonGetRequests += s.nonGetRequests;
      m.tunnels += s.tunnels;
      m.solved ||= s.solved;
      for (const [code, n] of Object.entries(s.statuses)) m.statuses[code] = (m.statuses[code] ?? 0) + n;
      if (s.solved && s.requests + s.tunnels > 0) m.provenIn.push(f.file);
    }
  }
  return out;
}

/**
 * A lab counts as "proxy-verified" only if, within ONE test file, it was really solved (the
 * control plane's server-side verifier recorded the solve) while the learner-side traffic to
 * it went through the proxy.
 *
 * Browser-triggered labs are never counted: their payload executes in a real Chromium (the
 * admin bot) that is not routed through the proxy, and some of them (DOM-fragment XSS,
 * clickjacking) have an exploit that no HTTP proxy can see at all. Claiming those would be
 * claiming more than was tested.
 */
export function proxyVerdict(s: MergedLabStats | undefined, opts: { browserTriggered?: boolean } = {}): { ok: boolean; reason?: string } {
  if (opts.browserTriggered) {
    return { ok: false, reason: "exploit is triggered in a real browser (admin bot) that is not routed through the proxy" };
  }
  if (!s) return { ok: false, reason: "not exercised in the proxy run" };
  if (s.requests + s.tunnels === 0) return { ok: false, reason: "no traffic went through the proxy" };
  if (s.provenIn.length === 0) {
    return { ok: false, reason: s.solved ? "solved in a test file where none of its traffic went through the proxy" : "traffic went through the proxy but the lab was never solved that way" };
  }
  return { ok: true };
}

export interface Evaluation {
  proven: string[];
  notProven: { id: string; reason: string }[];
  /** Manifest labs absent from every report: the run was partial, so nothing can be concluded. */
  missingFromReports: string[];
  /** Lab ids in the reports that have no manifest (stale reports or a test typo). */
  unknownInReports: string[];
  claimedNotProven: string[];
  provenNotClaimed: string[];
}

export function evaluate(manifestIds: string[], merged: Record<string, MergedLabStats>, claimed: Set<string>, browserLabs: Set<string> = new Set()): Evaluation {
  const ids = new Set(manifestIds);
  const proven: string[] = [];
  const notProven: { id: string; reason: string }[] = [];
  for (const id of [...manifestIds].sort()) {
    const v = proxyVerdict(merged[id], { browserTriggered: browserLabs.has(id) });
    if (v.ok) proven.push(id);
    else notProven.push({ id, reason: v.reason! });
  }
  const provenSet = new Set(proven);
  return {
    proven,
    notProven,
    missingFromReports: [...manifestIds].filter((id) => !(id in merged)).sort(),
    unknownInReports: Object.keys(merged).filter((id) => !ids.has(id)).sort(),
    claimedNotProven: [...claimed].filter((id) => ids.has(id) && !provenSet.has(id)).sort(),
    provenNotClaimed: proven.filter((id) => !claimed.has(id)),
  };
}

/** Sets `verifiedViaProxy` on every lab entry (true only for proven labs); leaves everything else as is. */
export function applyProven(status: Record<string, any>, proven: Set<string>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(status)) {
    if (key.startsWith("_") || typeof value !== "object" || value === null) {
      out[key] = value;
      continue;
    }
    const { verifiedViaProxy: _old, ...rest } = value;
    // keep field order stable: put the new flag right after verifiedExternalClient when present
    const entries = Object.entries(rest);
    const idx = entries.findIndex(([k]) => k === "verifiedExternalClient");
    entries.splice(idx >= 0 ? idx + 1 : entries.length, 0, ["verifiedViaProxy", proven.has(key)]);
    out[key] = Object.fromEntries(entries);
  }
  return out;
}
