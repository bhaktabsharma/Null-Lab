import fs from "node:fs";
import path from "node:path";
import { LabManifestSchema, type LabManifest } from "@nulllab/shared";
import { REPO_ROOT } from "../env.js";
import type { ControlDb } from "../db.js";

export interface CatalogEntry {
  manifest: LabManifest;
  /** Absolute path to the lab's own directory (contains server.ts, Dockerfile, etc). */
  dir: string;
}

function findManifestFiles(root: string): string[] {
  const results: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === "manifest.json") {
        results.push(full);
      }
    }
  }
  return results.sort();
}

/**
 * Loads every lab manifest from disk (data-driven — nothing is hardcoded
 * into the frontend or the API), validates each one strictly, and upserts
 * it into the `labs` table so the catalogue can be queried/filtered with
 * SQL. Throws on an invalid manifest rather than silently skipping it, so
 * a broken lab is caught at boot, not discovered by a user mid-exploit.
 */
export function loadCatalog(db: ControlDb): Map<string, CatalogEntry> {
  const labsRoot = path.join(REPO_ROOT, "labs");
  const files = findManifestFiles(labsRoot);
  const catalog = new Map<string, CatalogEntry>();

  const upsert = db.prepare(`
    INSERT INTO labs (id, version, title, objective, family, subcategory, difficulty, tags_json, estimated_minutes, manifest_json, updated_at)
    VALUES (@id, @version, @title, @objective, @family, @subcategory, @difficulty, @tags_json, @estimated_minutes, @manifest_json, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      version=excluded.version, title=excluded.title, objective=excluded.objective,
      family=excluded.family, subcategory=excluded.subcategory, difficulty=excluded.difficulty,
      tags_json=excluded.tags_json, estimated_minutes=excluded.estimated_minutes,
      manifest_json=excluded.manifest_json, updated_at=excluded.updated_at
  `);

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const result = LabManifestSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `[catalog] invalid manifest at ${file}:\n` +
          result.error.issues.map((i) => ` - ${i.path.join(".")}: ${i.message}`).join("\n"),
      );
    }
    const manifest = result.data;
    if (catalog.has(manifest.id)) {
      throw new Error(`[catalog] duplicate lab id "${manifest.id}" (second definition at ${file})`);
    }
    const dir = path.dirname(file);
    catalog.set(manifest.id, { manifest, dir });

    upsert.run({
      id: manifest.id,
      version: manifest.version,
      title: manifest.title,
      objective: manifest.objective,
      family: manifest.family,
      subcategory: manifest.subcategory,
      difficulty: manifest.difficulty,
      tags_json: JSON.stringify(manifest.tags),
      estimated_minutes: manifest.estimatedMinutes,
      manifest_json: JSON.stringify(manifest),
      updated_at: new Date().toISOString(),
    });
  }

  console.log(`[catalog] loaded ${catalog.size} lab manifest(s) from ${labsRoot}`);
  return catalog;
}
