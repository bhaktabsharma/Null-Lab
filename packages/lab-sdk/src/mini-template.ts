/**
 * MiniTemplate — a deliberately small template engine for SSTI labs.
 *
 * It supports `{{ expression }}` where an expression is a dotted path into
 * the render context (`user.name`, `config.SECRET_KEY`, `items[0]`), a string
 * or number literal, optionally followed by filters (`| upper`, `| lower`,
 * `| title`, `| trim`, `| length`, `| default('x')`). It is evaluated by a
 * hand-written parser — never `eval`/`Function` — and can only read OWN
 * properties of plain data in the context it is handed: no prototypes, no
 * constructors, no functions, so template injection here can leak the data
 * you put in the context but can never reach code, files or the process.
 */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SOURCE = 2000;
const MAX_EXPANSIONS = 50;
const MAX_OUTPUT = 8000;

export function renderTemplate(source: string, context: Record<string, unknown>): string {
  if (source.length > MAX_SOURCE) return "[template error: template too long]";
  let expansions = 0;
  const out = source.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => {
    if (++expansions > MAX_EXPANSIONS) return "[template error: too many expressions]";
    try {
      return evaluate(expr.trim(), context);
    } catch (err) {
      return `[template error: ${(err as Error).message}]`;
    }
  });
  return out.slice(0, MAX_OUTPUT);
}

function splitTop(expr: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const c of expr) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === sep) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
}

function literal(token: string): unknown | undefined {
  if (/^'[^']*'$/.test(token) || /^"[^"]*"$/.test(token)) return token.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  return undefined;
}

function resolvePath(path: string, ctx: Record<string, unknown>): unknown {
  if (!/^[A-Za-z_][A-Za-z0-9_]*((\.[A-Za-z_][A-Za-z0-9_]*)|(\[\d+\]))*$/.test(path)) throw new Error(`unexpected token "${path.slice(0, 30)}"`);
  const segments = path.match(/[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g)!;
  let cur: unknown = ctx;
  for (const seg of segments) {
    const key = seg.startsWith("[") ? seg.slice(1, -1) : seg;
    if (FORBIDDEN.has(key)) throw new Error(`access to "${key}" is not allowed`);
    if (typeof cur !== "object" || cur === null || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (typeof cur === "function") throw new Error("functions are not callable from templates");
  }
  return cur;
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v).slice(0, 2000);
}

function evaluate(expr: string, ctx: Record<string, unknown>): string {
  if (expr === "") return "";
  const [primary = "", ...filters] = splitTop(expr, "|");
  let value: unknown = literal(primary);
  if (value === undefined) value = resolvePath(primary, ctx);

  for (const f of filters) {
    const m = /^([a-z]+)(?:\((.*)\))?$/.exec(f);
    if (!m) throw new Error(`bad filter "${f.slice(0, 30)}"`);
    const name = m[1]!;
    const arg = m[2] !== undefined ? literal(m[2].trim()) : undefined;
    switch (name) {
      case "upper": value = stringify(value).toUpperCase(); break;
      case "lower": value = stringify(value).toLowerCase(); break;
      case "title": value = stringify(value).replace(/\b\w/g, (c) => c.toUpperCase()); break;
      case "trim": value = stringify(value).trim(); break;
      case "length": value = Array.isArray(value) ? value.length : stringify(value).length; break;
      case "default": if (value === undefined || value === null || value === "") value = arg ?? ""; break;
      default: throw new Error(`unknown filter "${name}"`);
    }
  }
  return stringify(value);
}
