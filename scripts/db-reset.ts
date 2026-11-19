#!/usr/bin/env tsx
/**
 * Deletes NULLLAB's local data: the control-plane database (accounts,
 * progress, XP, instance history) and any leftover per-instance lab
 * databases under data/instances/. This never touches anything outside
 * the repo's own data/ directory.
 *
 * Usage: npm run db:reset           (asks for confirmation)
 *        npm run db:reset -- --yes  (skips confirmation, for CI/scripts)
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(REPO_ROOT, "data");

function listTargets(): string[] {
  const targets: string[] = [];
  if (!fs.existsSync(DATA_DIR)) return targets;
  for (const entry of fs.readdirSync(DATA_DIR)) {
    if (entry.startsWith("control.db")) targets.push(path.join(DATA_DIR, entry));
  }
  const instancesDir = path.join(DATA_DIR, "instances");
  if (fs.existsSync(instancesDir)) {
    for (const entry of fs.readdirSync(instancesDir)) {
      if (entry.endsWith(".db")) targets.push(path.join(instancesDir, entry));
    }
  }
  return targets;
}

async function confirm(question: string): Promise<boolean> {
  if (process.argv.includes("--yes") || process.argv.includes("-y")) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const targets = listTargets();
  if (targets.length === 0) {
    console.log("Nothing to reset — no local NULLLAB data found under data/.");
    return;
  }

  console.log("This will permanently delete:");
  for (const t of targets) console.log(`  - ${path.relative(REPO_ROOT, t)}`);
  console.log("\nThis removes all accounts, progress, XP, and solve history on this install.");

  const ok = await confirm("Continue? [y/N] ");
  if (!ok) {
    console.log("Cancelled — nothing was deleted.");
    return;
  }

  for (const t of targets) {
    fs.rmSync(t, { force: true });
  }
  console.log(`\nDeleted ${targets.length} file(s). Run "npm run dev" (or restart the server) for a clean install.`);
}

main().catch((err) => {
  console.error("db:reset failed:", err);
  process.exit(1);
});
