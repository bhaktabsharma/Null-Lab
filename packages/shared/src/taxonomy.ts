/**
 * Vulnerability taxonomy for NULLLAB.
 *
 * This mirrors the families in the NULLLAB master spec (OWASP Top 10 / API
 * Security Top 10 / WSTG-informed). It is intentionally versioned and
 * extensible: adding a family or subcategory here does NOT imply any lab
 * exists for it yet. Whether a subcategory has real, tested labs is tracked
 * separately in the coverage matrix (see `coverage.ts`), which is generated
 * from what is actually implemented on disk — never hand-claimed here.
 */

export const TAXONOMY_VERSION = "2026.1" as const;

export type FamilyId =
  | "access-control"
  | "injection"
  | "client-side"
  | "auth-session"
  | "ssrf"
  | "file-handling"
  | "server-logic"
  | "api-security"
  | "information-disclosure"
  | "xml-parsers"
  | "misconfiguration"
  | "modern-platform";

export interface FamilyDefinition {
  id: FamilyId;
  title: string;
  shortCode: string;
  description: string;
  subcategories: string[];
}

export const FAMILIES: Record<FamilyId, FamilyDefinition> = {
  "access-control": {
    id: "access-control",
    shortCode: "A",
    title: "Access Control & Authorization",
    description:
      "IDOR/BOLA, broken function-level authorization, privilege escalation, multi-tenant isolation failures.",
    subcategories: [
      "idor",
      "bola",
      "broken-function-level-authz",
      "broken-object-property-authz",
      "horizontal-privesc",
      "vertical-privesc",
      "multi-tenant-isolation",
      "alternate-endpoint-authz-bypass",
      "forced-browsing",
      "uuid-identifier-authz",
      "nested-object-authz",
      "bulk-endpoint-authz",
      "workflow-step-authz",
      "org-invitation-privesc",
      "ownership-transfer",
      "contact-info-takeover",
      "graphql-mutation-authz",
      "async-job-authz",
      "signed-url-authz",
      "role-inheritance",
      "permission-downgrade",
      "approval-chain-authz",
      "ownership-toctou",
      "cross-tenant-reference",
      "method-override-authz",
      "share-recipient-binding",
    ],
  },
  injection: {
    id: "injection",
    shortCode: "B",
    title: "Injection",
    description:
      "SQL injection (classic/blind/second-order), NoSQL, command, template, header/log injection.",
    subcategories: [
      "sqli-error-based",
      "sqli-union-based",
      "sqli-boolean-blind",
      "sqli-time-blind",
      "sqli-second-order",
      "sqli-auth-bypass",
      "nosqli",
      "os-command-injection",
      "server-side-template-injection",
      "header-crlf-injection",
      "log-injection",
      "sqli-order-by",
      "ldap-injection",
      "xpath-injection",
    ],
  },
  "client-side": {
    id: "client-side",
    shortCode: "C",
    title: "Cross-Site Scripting & Browser-Side",
    description:
      "Reflected/stored/DOM XSS, CSRF, clickjacking, open redirects, CORS misconfiguration.",
    subcategories: [
      "xss-reflected",
      "xss-stored",
      "xss-dom",
      "csrf",
      "open-redirect",
      "clickjacking",
      "cors-misconfiguration",
      "postmessage-origin",
    ],
  },
  "auth-session": {
    id: "auth-session",
    shortCode: "D",
    title: "Authentication, Identity & Session Management",
    description:
      "Password reset flaws, session fixation, JWT issues, broken MFA, OAuth/OIDC errors.",
    subcategories: [
      "password-reset-flaws",
      "session-fixation",
      "session-invalidation",
      "jwt-validation",
      "mfa-bypass",
      "account-enumeration",
      "oauth-oidc-errors",
      "remember-me-token",
      "credential-stuffing-no-lockout",
    ],
  },
  ssrf: {
    id: "ssrf",
    shortCode: "E",
    title: "Server-Side Request Forgery",
    description: "Basic/blind SSRF, host validation bypass, webhook destination abuse.",
    subcategories: [
      "ssrf-basic",
      "ssrf-blind-callback",
      "ssrf-host-validation-bypass",
      "ssrf-webhook-abuse",
      "ssrf-document-rendering",
    ],
  },
  "file-handling": {
    id: "file-handling",
    shortCode: "F",
    title: "Path Traversal & File Handling",
    description: "Path traversal, LFI, upload validation bypass, zip slip, backup exposure.",
    subcategories: [
      "path-traversal",
      "lfi",
      "upload-validation-bypass",
      "zip-slip",
      "backup-file-exposure",
    ],
  },
  "server-logic": {
    id: "server-logic",
    shortCode: "G",
    title: "Server-Side & Application Logic",
    description:
      "Insecure deserialization, mass assignment, race conditions, business-logic & pricing abuse, cache poisoning.",
    subcategories: [
      "insecure-deserialization",
      "mass-assignment",
      "race-condition",
      "price-manipulation",
      "workflow-step-skipping",
      "cache-poisoning",
      "request-smuggling",
      "refund-idempotency",
      "refund-amount-calculation",
      "refund-initiation",
      "coupon-stacking",
      "coupon-account-binding",
      "referral-reward-trigger",
      "subscription-entitlement-timing",
      "payment-return-integrity",
      "transaction-replay",
      "multi-endpoint-race",
      "partial-completion",
      "currency-rounding",
      "balance-aliasing",
    ],
  },
  "api-security": {
    id: "api-security",
    shortCode: "H",
    title: "API Security",
    description: "BOLA/BFLA on APIs, excessive data exposure, rate limiting, GraphQL/WebSocket flaws.",
    subcategories: [
      "api-excessive-data-exposure",
      "api-rate-limiting",
      "api-mass-assignment",
      "api-version-inconsistency",
      "graphql-introspection-authz",
      "websocket-authz",
      "webhook-signature",
      "api-key-scope",
      "graphql-batching",
      "graphql-alias-abuse",
      "content-type-validation",
      "batch-endpoint-authz",
      "websocket-message-authz",
    ],
  },
  "information-disclosure": {
    id: "information-disclosure",
    shortCode: "L",
    title: "Information Disclosure",
    description:
      "Source maps, secrets shipped to the browser, debug and diagnostic endpoints, verbose errors, over-broad exports and public storage — and what an attacker can do with what leaks.",
    subcategories: [
      "source-map-exposure",
      "frontend-secret-exposure",
      "debug-endpoint-exposure",
      "verbose-error-disclosure",
      "export-data-exposure",
      "storage-acl-mistake",
    ],
  },
  "xml-parsers": {
    id: "xml-parsers",
    shortCode: "I",
    title: "XML, Parser & Content Processing",
    description: "XXE (incl. blind), parser misconfiguration, unsafe document processing.",
    subcategories: ["xxe-basic", "xxe-blind", "parser-misconfiguration"],
  },
  misconfiguration: {
    id: "misconfiguration",
    shortCode: "J",
    title: "Misconfiguration & Deployment",
    description: "Exposed admin/debug endpoints, backup exposure, default credentials, verbose errors.",
    subcategories: [
      "exposed-admin-interface",
      "debug-endpoint-exposure",
      "directory-listing",
      "default-credentials",
      "verbose-errors",
      "host-header-trust",
      "http-parameter-pollution",
    ],
  },
  "modern-platform": {
    id: "modern-platform",
    shortCode: "K",
    title: "Modern Web Platform & Specialized",
    description: "Prototype pollution, service-worker scope issues, chained multi-step vulnerabilities.",
    subcategories: ["prototype-pollution", "service-worker-scope", "chained-vulnerabilities"],
  },
};

export const ALL_FAMILY_IDS = Object.keys(FAMILIES) as FamilyId[];
