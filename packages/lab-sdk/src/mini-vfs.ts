/**
 * MiniVfs — a fully SIMULATED filesystem for path-traversal / LFI / upload /
 * zip-slip labs.
 *
 * SAFETY: every operation here works against an in-memory `Map`, using
 * `node:path`'s `posix` helpers as PURE STRING MATH (they do no I/O — they
 * only manipulate path strings) to get real, standards-accurate traversal
 * and normalization behavior. There is no code path anywhere in this module
 * that opens a real file handle, so a payload like `../../../etc/passwd`
 * can never reach the real host filesystem, no matter how a lab's own
 * (deliberately flawed) path-joining logic is bypassed. This matters
 * because NULLLAB's default "process" runtime has no filesystem sandbox
 * (see docs/architecture.md) — a lab that actually opened files named by
 * attacker input would be a vulnerability in the platform itself.
 */
import { posix } from "node:path";

export interface FsEntry {
  content: string;
  contentType?: string;
}

export class MiniVfs {
  private readonly files = new Map<string, FsEntry>();

  constructor(seed: Record<string, string | FsEntry> = {}) {
    for (const [path, value] of Object.entries(seed)) {
      this.files.set(this.normalize(path), typeof value === "string" ? { content: value } : value);
    }
  }

  /**
   * Resolves a path the SAFE way: joins it under `base` and normalizes
   * `..`/`.`/repeated slashes with `posix.normalize` (string math only).
   * This is what a CORRECTLY written handler would call before comparing
   * the result against an allowed directory.
   */
  resolveUnder(base: string, requested: string): string {
    return this.normalize(posix.join(base, requested));
  }

  /** Normalizes a path to a clean, absolute, no-`..` form — same caveat: pure string math, no I/O. */
  normalize(path: string): string {
    const joined = path.startsWith("/") ? path : `/${path}`;
    return posix.normalize(joined);
  }

  /** True when `candidate` (already normalized) is `base` itself or lives under it. */
  isUnder(base: string, candidate: string): boolean {
    const b = this.normalize(base).replace(/\/+$/, "");
    const c = this.normalize(candidate);
    return c === b || c.startsWith(`${b}/`);
  }

  read(path: string): FsEntry | undefined {
    return this.files.get(this.normalize(path));
  }

  write(path: string, entry: FsEntry): void {
    this.files.set(this.normalize(path), entry);
  }

  exists(path: string): boolean {
    return this.files.has(this.normalize(path));
  }

  /** Lists direct children of a directory path (non-recursive), like a basic directory listing. */
  list(dir: string): string[] {
    const base = this.normalize(dir).replace(/\/+$/, "");
    const prefix = `${base}/`;
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      names.add(rest.split("/")[0]!);
    }
    return [...names].sort();
  }

  allPaths(): string[] {
    return [...this.files.keys()].sort();
  }
}

export interface ArchiveEntry {
  /** The path exactly as it appears inside the archive — may be malicious ("../" segments, absolute paths). */
  path: string;
  content: string;
}

/** A tiny in-memory stand-in for a .zip/.tar entry list — never parses or writes a real archive file. */
export function makeArchive(entries: ArchiveEntry[]): ArchiveEntry[] {
  return entries;
}
