/**
 * MiniDoc — a tiny in-memory, MongoDB-flavoured document store for NoSQL
 * injection labs. It is a real query matcher (not canned responses): queries
 * are plain objects, and operators like $ne / $gt / $regex are evaluated
 * against the documents. It has no network, no files, and no eval; $regex is
 * restricted (no groups, short, bounded subject) so a lab can never be made
 * to hang on catastrophic backtracking.
 */
export type Doc = Record<string, unknown>;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getField(doc: Doc, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (FORBIDDEN_KEYS.has(part) || !isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Restricted regex: no groups/backreferences, short, only the `i` flag. */
export function safeRegex(source: unknown, options: unknown): RegExp {
  if (typeof source !== "string" || source.length > 64) throw new Error("$regex must be a string of at most 64 characters");
  if (/[()]/.test(source) || /\\[1-9k]/.test(source)) throw new Error("$regex groups and backreferences are not supported");
  const flags = options === undefined ? "" : String(options);
  if (!/^i?$/.test(flags)) throw new Error("only the 'i' regex option is supported");
  return new RegExp(source, flags);
}

function eq(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return a.some((x) => eq(x, b));
  if (isPlainObject(a) || isPlainObject(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function cmp(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith("$"));
}

function fieldMatches(value: unknown, cond: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) throw new Error("query too deep");
  if (!isOperatorObject(cond)) return eq(value, cond);
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case "$eq": if (!eq(value, arg)) return false; break;
      case "$ne": if (eq(value, arg)) return false; break;
      case "$gt": { const c = cmp(value, arg); if (c === null || !(c > 0)) return false; break; }
      case "$gte": { const c = cmp(value, arg); if (c === null || !(c >= 0)) return false; break; }
      case "$lt": { const c = cmp(value, arg); if (c === null || !(c < 0)) return false; break; }
      case "$lte": { const c = cmp(value, arg); if (c === null || !(c <= 0)) return false; break; }
      case "$in": if (!Array.isArray(arg) || !arg.some((x) => eq(value, x))) return false; break;
      case "$nin": if (!Array.isArray(arg) || arg.some((x) => eq(value, x))) return false; break;
      case "$exists": if ((value !== undefined) !== Boolean(arg)) return false; break;
      case "$regex": {
        if (typeof value !== "string" || value.length > 200) return false;
        if (!safeRegex(arg, (cond as Record<string, unknown>)["$options"]).test(value)) return false;
        break;
      }
      case "$options": break; // consumed by $regex
      case "$not": if (fieldMatches(value, arg, depth + 1)) return false; break;
      default: throw new Error(`unsupported operator ${op}`);
    }
  }
  return true;
}

export function matches(doc: Doc, query: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) throw new Error("query too deep");
  if (!isPlainObject(query)) throw new Error("query must be an object");
  for (const [key, cond] of Object.entries(query)) {
    if (key === "$and" || key === "$or" || key === "$nor") {
      if (!Array.isArray(cond) || cond.length === 0 || cond.length > 20) throw new Error(`${key} needs a non-empty array`);
      const results = cond.map((c) => matches(doc, c, depth + 1));
      if (key === "$and" && !results.every(Boolean)) return false;
      if (key === "$or" && !results.some(Boolean)) return false;
      if (key === "$nor" && results.some(Boolean)) return false;
      continue;
    }
    if (key.startsWith("$")) throw new Error(`unsupported top-level operator ${key}`);
    if (!fieldMatches(getField(doc, key), cond, depth)) return false;
  }
  return true;
}

export class DocCollection<T extends Doc> {
  constructor(private readonly docs: T[]) {}
  find(query: unknown): T[] {
    return this.docs.filter((d) => matches(d, query));
  }
  findOne(query: unknown): T | null {
    return this.find(query)[0] ?? null;
  }
}
