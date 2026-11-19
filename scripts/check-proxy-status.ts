#!/usr/bin/env tsx
/**
 * Compares what the proxy run proved with what docs/lab-verification-status.json
 * claims, so "verified via proxy" is never a hand-edited assertion.
 *
 *   npm run test:proxy                    run the integration suite through the proxy, then check
 *   npm run proxy:status                  re-check the reports from the last run
 *   npm run proxy:status -- --write       update `verifiedViaProxy` in the status file from the reports
 *
 * A partial run (some labs absent from the reports) is refused outright: it can neither
 * confirm nor retract a claim.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyProven, evaluate, mergeReports, type ProxyReportFile } from "./proxy-status-lib.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = path.join(ROOT, "proxy-report");
const STATUS_FILE = path.join(ROOT, "docs", "lab-verification-status.json");
const write = process.argv.includes("--write");

function readManifests(): { ids: string[]; browserLabs: Set<string> } {
  const ids: string[] = [];
  const browserLabs = new Set<string>();
  const stack = [path.join(ROOT, "labs")];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === "manifest.json") {
        const m = JSON.parse(fs.readFileSync(full, "utf8"));
        ids.push(m.id);
        if (m.verifier?.requiresBrowserBot === true) browserLabs.add(m.id);
      }
    }
  }
  return { ids, browserLabs };
}

if (!fs.existsSync(REPORT_DIR) || fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith(".json")).length === 0) {
  console.error("No proxy reports found in proxy-report/. Run `npm run test:proxy` first.");
  process.exit(2);
}

const reports: ProxyReportFile[] = fs
  .readdirSync(REPORT_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(REPORT_DIR, f), "utf8")));
const merged = mergeReports(reports);
const { ids, browserLabs } = readManifests();
const status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")) as Record<string, any>;
const claimed = new Set(Object.entries(status).filter(([k, v]) => !k.startsWith("_") && v?.verifiedViaProxy === true).map(([k]) => k));
const ev = evaluate(ids, merged, claimed, browserLabs);

const totalReq = Object.values(merged).reduce((n, s) => n + s.requests, 0);
const totalTun = Object.values(merged).reduce((n, s) => n + s.tunnels, 0);
const blocked = reports.reduce((n, r) => n + r.blocked, 0);
console.log(`Proxy reports: ${reports.length} test file(s), ${totalReq} proxied HTTP request(s), ${totalTun} CONNECT tunnel(s), ${blocked} blocked attempt(s).`);

if (ev.missingFromReports.length > 0) {
  console.error(`\nPartial run: ${ev.missingFromReports.length} lab(s) appear in no report, so nothing can be concluded:`);
  for (const id of ev.missingFromReports) console.error(`  - ${id}`);
  console.error("Run the full `npm run test:proxy`.");
  process.exit(2);
}
if (ev.unknownInReports.length > 0) {
  console.error(`\nReports mention lab ids with no manifest (stale reports?): ${ev.unknownInReports.join(", ")}`);
  process.exit(2);
}

console.log(`\nProxy-verified (solved, within one test file, while all learner traffic went through the proxy): ${ev.proven.length} / ${ids.length}`);
if (ev.notProven.length > 0) {
  console.log("Not proxy-verified:");
  for (const n of ev.notProven) console.log(`  - ${n.id}: ${n.reason}`);
}

if (write) {
  const next = applyProven(status, new Set(ev.proven));
  fs.writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`\nUpdated verifiedViaProxy for ${ids.length} lab(s) in ${path.relative(ROOT, STATUS_FILE)}.`);
  process.exit(0);
}

let failed = false;
if (ev.claimedNotProven.length > 0) {
  failed = true;
  console.error(`\nERROR: status file claims proxy verification this run did not prove: ${ev.claimedNotProven.join(", ")}`);
}
if (ev.provenNotClaimed.length > 0) {
  failed = true;
  console.error(`\nERROR: proven by this run but not recorded in the status file: ${ev.provenNotClaimed.join(", ")}`);
}
if (failed) {
  console.error("Run `npm run proxy:status -- --write` and commit docs/lab-verification-status.json.");
  process.exit(1);
}
console.log("\nStatus file matches the proxy run.");
