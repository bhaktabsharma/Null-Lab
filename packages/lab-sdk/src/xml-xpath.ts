import { DOMParser } from "@xmldom/xmldom";
import * as xpath from "xpath";

/**
 * Thin wrappers over the real `xpath` + `@xmldom/xmldom` libraries for the
 * XPath-injection lab. The XML is always a trusted, in-memory string the lab
 * built itself: there is no DTD/entity processing of learner input and no
 * file or network access, so only the XPath *expression* is attacker-influenced.
 */
export function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
}

const MAX_EXPR = 300;

/** Evaluates an XPath expression and returns the matching element nodes (an empty list for scalar results). */
export function xpathElements(expr: string, doc: Document): Element[] {
  if (expr.length > MAX_EXPR) throw new Error("XPath expression too long");
  const result = xpath.select(expr, doc as unknown as Node);
  return Array.isArray(result) ? (result as unknown as Element[]) : [];
}

/** Evaluates an XPath expression to a scalar string/number/boolean when the result is not a node-set. */
export function xpathScalar(expr: string, doc: Document): string | number | boolean | null {
  if (expr.length > MAX_EXPR) throw new Error("XPath expression too long");
  const result = xpath.select(expr, doc as unknown as Node);
  return Array.isArray(result) ? null : (result as string | number | boolean);
}

/** Text of the first child element with the given tag name, or "". */
export function childText(el: Element, tag: string): string {
  const child = el.getElementsByTagName(tag)[0];
  return child?.textContent ?? "";
}
