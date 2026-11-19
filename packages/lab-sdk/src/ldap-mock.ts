/**
 * LdapMock — an in-memory directory and an RFC 4515-style search-filter
 * evaluator for LDAP-injection labs. No network, no real LDAP server.
 *
 * Supported filters: `(&…)`, `(|…)`, `(!…)`, equality, substring/wildcard
 * (`(cn=ad*)`), presence (`(uid=*)`), `>=`, `<=`, `~=`; `(&)` and `(|)` are
 * the RFC 4526 absolute true/false filters. Like several permissive real
 * implementations, `ldapSearch` evaluates the FIRST complete filter and
 * ignores any trailing text — that leniency is what makes classic
 * filter-injection payloads work, and it is documented here on purpose.
 */
export interface LdapEntry {
  dn: string;
  attrs: Record<string, string[]>;
}

export type FilterNode =
  | { type: "and" | "or"; children: FilterNode[] }
  | { type: "not"; child: FilterNode }
  | { type: "present"; attr: string }
  | { type: "eq"; attr: string; parts: string[] }
  | { type: "cmp"; op: ">=" | "<=" | "~="; attr: string; value: string };

export class LdapFilterError extends Error {}

const MAX_FILTER = 400;
const MAX_DEPTH = 20;

export function parseFilter(input: string): { node: FilterNode; rest: string } {
  if (input.length > MAX_FILTER) throw new LdapFilterError("filter too long");
  let pos = 0;

  const expect = (ch: string) => {
    if (input[pos] !== ch) throw new LdapFilterError(`expected '${ch}' at position ${pos}`);
    pos++;
  };

  const parseOne = (depth: number): FilterNode => {
    if (depth > MAX_DEPTH) throw new LdapFilterError("filter nested too deeply");
    expect("(");
    const c = input[pos];
    let node: FilterNode;
    if (c === "&" || c === "|") {
      pos++;
      const children: FilterNode[] = [];
      while (input[pos] === "(") children.push(parseOne(depth + 1));
      node = { type: c === "&" ? "and" : "or", children };
    } else if (c === "!") {
      pos++;
      node = { type: "not", child: parseOne(depth + 1) };
    } else {
      const start = pos;
      while (pos < input.length && input[pos] !== ")") {
        if (input[pos] === "(") throw new LdapFilterError(`unescaped '(' at position ${pos}`);
        pos++;
      }
      const item = input.slice(start, pos);
      const m = /^([A-Za-z][A-Za-z0-9.;-]*)(>=|<=|~=|=)(.*)$/s.exec(item);
      if (!m) throw new LdapFilterError(`bad filter item "${item.slice(0, 40)}"`);
      const attr = m[1]!.toLowerCase();
      const op = m[2]!;
      const raw = m[3]!;
      if (op === "=") {
        if (raw === "*") node = { type: "present", attr };
        else node = { type: "eq", attr, parts: splitWildcards(raw) };
      } else {
        node = { type: "cmp", op: op as ">=" | "<=" | "~=", attr, value: unescapeValue(raw) };
      }
    }
    expect(")");
    return node;
  };

  const node = parseOne(0);
  return { node, rest: input.slice(pos) };
}

function unescapeValue(v: string): string {
  return v.replace(/\\([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Splits on unescaped `*`; `\2a` stays a literal star. */
function splitWildcards(raw: string): string[] {
  return raw.split("*").map(unescapeValue);
}

function valuesOf(entry: LdapEntry, attr: string): string[] {
  for (const [k, v] of Object.entries(entry.attrs)) if (k.toLowerCase() === attr) return v;
  return [];
}

function wildcardMatch(parts: string[], value: string): boolean {
  const v = value.toLowerCase();
  const p = parts.map((x) => x.toLowerCase());
  if (p.length === 1) return v === p[0];
  if (!v.startsWith(p[0]!)) return false;
  let idx = p[0]!.length;
  for (let i = 1; i < p.length - 1; i++) {
    const found = v.indexOf(p[i]!, idx);
    if (found === -1) return false;
    idx = found + p[i]!.length;
  }
  const last = p[p.length - 1]!;
  return v.length - last.length >= idx && v.endsWith(last);
}

export function matchesFilter(entry: LdapEntry, node: FilterNode): boolean {
  switch (node.type) {
    case "and": return node.children.every((c) => matchesFilter(entry, c)); // (&) is true
    case "or": return node.children.some((c) => matchesFilter(entry, c)); //  (|) is false
    case "not": return !matchesFilter(entry, node.child);
    case "present": return valuesOf(entry, node.attr).length > 0;
    case "eq": return valuesOf(entry, node.attr).some((v) => wildcardMatch(node.parts, v));
    case "cmp": {
      const target = node.value.toLowerCase();
      return valuesOf(entry, node.attr).some((v) => {
        const x = v.toLowerCase();
        return node.op === ">=" ? x >= target : node.op === "<=" ? x <= target : x === target;
      });
    }
  }
}

/** Evaluates the first complete filter in `filter`; trailing text is ignored (documented leniency). */
export function ldapSearch(entries: LdapEntry[], filter: string): LdapEntry[] {
  const { node } = parseFilter(filter);
  return entries.filter((e) => matchesFilter(e, node));
}
