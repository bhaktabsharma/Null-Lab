# Audit report and implementation checklist

Audit of Milestone 1 (9 labs) and the Phase 2 fixes made in response.
Everything below is labelled with *how* it was established. "Not run" means
exactly that.

## Baseline (before any change)

`npm ci`, `typecheck`, `lint`, `build` clean; 15 unit + 33 integration tests passing.
All 9 labs implemented with real targets: IDOR ×3, SQLi ×3, XSS ×3.

## Findings

| # | Severity | Finding | How established | Status |
|---|---|---|---|---|
| F1 | Critical | Default Compose image can't launch **any** lab: `tsx` (spawned for every lab) was a devDependency, but the image installs with `--omit=dev` | Reproduced: `npm ci --omit=dev` leaves no `node_modules/.bin/tsx` | Fixed. Verified by assembling the image's file layout and launching a lab from it (process mode). `docker build` **not run** |
| F2 | Critical | In Compose, labs bound the container's loopback and ports 5100–5199 weren't published, so the URL the UI shows can't be reached from a browser/Burp | Static analysis of `startLabApp` + `docker-compose.yml` | Fixed (`LAB_BIND_HOST`, loopback-only port publishing). Bind behaviour tested on a real non-loopback interface; Compose publishing **not run** |
| F3 | High | Chromium installed to root's cache but `PLAYWRIGHT_BROWSERS_PATH` pointed at an empty dir → XSS labs would fail in the image | Static analysis (ENV set after the install step) | Reordered. **Not run** |
| F4 | High | Docker runtime couldn't work: ports can't be published from an `--internal` network; labs couldn't call back; host db path used in container; `docker build` on every launch; control plane image had no `docker` CLI | Static analysis of `docker-runtime.ts` | Redesigned (forwarder + shared image + alias + labels). Stub-CLI unit tests + real-socket forwarder tests. **Not run against a daemon** |
| F5 | High | A control plane that crashes/is SIGKILLed leaves labs serving with valid tokens forever | Reproduced: SIGKILL → lab still answers 200 | Fixed (process groups, argv marker, boot reaping). Verified with real processes; test fails when the fix is removed |
| F6 | Medium | Failed launch leaked the port and any half-started process | Code reading | Fixed; unit-tested (test fails when fix removed) |
| F7 | Medium | A lab that died stayed "running" in the UI/API | Code reading | Fixed; unit-tested |
| F8 | Medium | Per-instance SQLite files were never deleted on stop/expiry (`data/instances` grew unboundedly) | Observed accumulated files | Fixed; integration-tested |
| F9 | High | No CSRF protection on cookie-authenticated `/api`, while lab pages run attacker JS by design | Analysis (same-machine cross-origin POST with cookie) | Fixed (Origin guard). Tested over real HTTP; **not** exercised from a real browser attack page |
| F10 | Low | `NULLLAB_CHROMIUM_NO_SANDBOX="false"` parsed as `true` | Code reading | Fixed; unit-tested |
| F11 | Medium | Coverage matrix header said "Verified (external/Burp)" but tests use a plain Node HTTP client | Code reading | Relabelled "raw HTTP client"; explicit note that **no lab has been proxy- or Burp-tested** |

Noted once, not reproduced: after one smoke run, `ps` showed 2 leftover lab processes that were gone
by the next check; repeated runs showed none at any sample. Most likely a leftover from a deliberately
broken test run, but that is a guess.

## Open issues (not yet fixed)

- **Cookie-name collision between labs.** Cookies are keyed by host, not port. Two labs both use
  `shopmart_session`; running both at once would overwrite each other's cookie. Found by reading;
  not yet reproduced in a browser. Planned for the framework batch (instance-scoped cookie names).
- Docker mode: control-plane `/api` reachable from lab containers (token/login still required). Documented.
- Process mode is logical isolation only (documented). Windows-native Node has no orphan reaping.
- Browser tests cover only 2 flows (login/launch/theme, register/login). Reset, stop, search/filter,
  failed verification, and error states are not browser-tested yet.
- No proxy/Burp compatibility test exists for any lab.
- `.env.example` range `5100–5999` vs Compose `5100–5199` (documented).

## Checklist

Legend: ✅ done and verified as stated · 🟡 done, not verifiable here · ⬜ not started

**Phase 1 — audit/preserve:** ✅ audit · ✅ baseline · ✅ git checkpoint · ✅ the 9 labs, IDs, verifiers and
progress unchanged (all their existing tests still pass) · ✅ honest coverage matrix wording

**Phase 2 — deployment:** ✅ labs reachable on a non-loopback bind (process mode) · ✅ health checks detect dead
targets · ✅ cleanup on failure/stop/reset · ✅ stale-instance reaping · ✅ CSRF/Origin guard · ✅ port release ·
🟡 Compose lab-port publishing · 🟡 image builds · 🟡 docker runtime end-to-end (`npm run docker:selftest`) ·
⬜ internal-only listener for `/internal` · ⬜ proxy-compatibility test

**Phase 3 — lab framework:** ⬜ manifest v2 (seed data, reset spec, test spec, hints, Burp notes, prerequisites) ·
⬜ shared lab test-fixture helpers · ⬜ instance-scoped cookie names · ⬜ request/response capture for the raw-HTTP workspace

**Phase 4/5 — new labs:** ⬜ none yet (A access control · B injection · C client-side · D auth/session · E SSRF ·
F files · G business logic/races · H API/GraphQL/WebSocket · I XML/deserialization · J HTTP desync ·
K caching/CORS/CSRF · L misc). Order: core web/API first, then auth, SSRF, files, logic, advanced protocol.

**Phase 6 — frontend:** ⬜ filters/search/coverage page/raw-HTTP workspace/launch-reset-stop UX polish
**Phase 7 — Burp:** ⬜ **Phase 8 — tests:** partially (see above) **Phase 9 — docs:** 🟡 updated for Phase 2 only

## Test results at this revision

`typecheck` ✅ · `lint` ✅ · `build` ✅ · unit 36/36 ✅ · integration 46/46 ✅ · e2e 2/2 ✅ ·
`npm run smoke` 13/13 ✅ (process mode, local) · `docker compose config` / `up --build` / `docker:selftest`: **not run** (no Docker daemon available).


## Update — Phase 3 framework + Batch 1 (access control)

New findings while building (all fixed):

| # | Finding | How established | Status |
|---|---|---|---|
| F12 | `npm run typecheck` never type-checked any lab (`labs/` wasn't in the project graph) | Read `tsconfig.json`; confirmed `labs/tsconfig.json` unreferenced | Fixed: `typecheck` now runs `tsc -p labs`; all 20 labs pass strict mode |
| F13 | `GET /api/labs/:id` sent the **full manifest** to every learner, including `verifier.condition` (describes the exploit in words) and `solutionHint` | Read the route; contract test reproduced the leak | Fixed: learner-facing projection (`PublicLabManifest`), hints served one at a time on request, debrief only after a real solve. Reverting the fix makes the contract test fail |
| F14 | Hard-coded "9 cards" in the e2e test and README | Code reading | Fixed: e2e compares against the backend's own count |

Added: lab kit in the SDK (instance-scoped cookie names — resolving the cookie-collision
issue for all new labs; shared login routes; per-instance UUIDs), manifest fields
(`weakness`, `vulnerableEndpoint`, `seededData`, `hints`, `spoilers`, `burpNotes`), a lab
contract test that runs against every lab, a difficulty filter in the catalogue, hint/debrief/
stop UI, and **11 access-control labs** (forced browsing, role-in-cookie, identity-in-cookie,
BFLA, method switch, leaked UUIDs, nested object, bulk endpoint, property-level fields, tenant
header, edit-after-approval). Each has a lab-specific test (ordinary use, near-misses, exploit,
XP exactly once) and two of them were mutation-checked (fixing the hole / over-eager solve both
turn the tests red).

Honest limits of this batch: access control has no **advanced**-difficulty lab yet (1 hard);
the old-lab cookie names are unchanged (they predate the scoped-cookie helper and were not
refactored); no browser-driven or proxy/Burp test exists for the new labs.


## Update — Batch 4 (client-side)

4 labs: DOM-based XSS, open redirect, CORS misconfiguration, clickjacking. The clickjacking lab's
first version FAILED its own test (the framed button's CSS let it collapse to its default height
rather than filling the iframe, so the real click landed just below it) — found by instrumenting a
standalone Playwright script against the running instance and inspecting the button's actual
bounding box, not by assuming the layout was right. Fixed and re-verified before the test was
accepted as passing.

**Not implemented, declared rather than faked:** `csrf` and `postmessage-origin`. Both need two
distinct origins (a vulnerable app and a separate attacker/exploit server) to be meaningful —
Burp Suite/PortSwigger-style labs solve this with an "exploit server"; this runtime currently gives
each lab instance exactly one port/origin. Implementing it properly means extending the manifest,
orchestrator (SpawnRequest/SpawnResult), instance manager, and workspace UI to support an optional
second, independently-reachable origin per instance — a real framework change, not a one-lab hack.
Rather than build a same-origin stand-in that wouldn't actually demonstrate cross-origin behavior,
these are left as designed-but-not-built and tracked for a future batch.

## Dependency audit note (pre-existing, not introduced by this work)

`npm ci` reports 14 moderate-severity advisories, all transitive, via `@fastify/static` (glob) and
the ESLint/typescript-eslint toolchain (minimatch) — confirmed present in the originally delivered
Milestone 1 zip before any of these changes, not something this work introduced. `npm audit fix
--force` resolves them but pulls breaking major-version bumps of `@fastify/static` and
`typescript-eslint`; that's a deliberate upgrade decision, not something to do silently as a side
effect of a security-fix batch, so it's left for a dedicated dependency-upgrade pass.


## Update — Batch 5 (auth-session)

9 labs. Two bugs caught before commit, both from reusing `registerPasswordLogin` (which already
registers GET /logout) and then ALSO hand-writing a `/logout` route in the lab file — Fastify
throws on the duplicate registration at startup, so the instance failed its health check and the
launch API correctly reported an error rather than silently leaving a broken process running. Now
fixed in the one affected lab (auth-reset-predictable-token); the pattern is otherwise consistent
across every lab already using the shared login helper.


## Update — Batch 6 (SSRF)

6 labs, 0 bugs found this round. Before writing any lab, verified Node's real `URL` parser
normalization behavior (decimal/hex/octal IPv4, userinfo-vs-host) with a standalone script, so the
IP-encoding-bypass lab's claims are grounded in actual, tested parser behavior rather than assumed
textbook examples. All SSRF labs route through a new simulated-network module rather than ever
calling a real fetch — see the SECURITY.md addition and the module's own doc comment for why this
is a hard requirement here, not a style choice: `process` mode (the default runtime) has no network
sandbox, so a lab that really dialed out on attacker-supplied input would make the training
platform itself exploitable for scanning or reaching whatever network the platform runs on.


## Update — Batch 7 (file handling)

6 labs. One test-authoring bug caught before commit: a "single URL-encoding" negative-test value
was accidentally built by wrapping an already-percent-encoded string in a second `encodeURIComponent`,
silently producing the double-encoded payload instead and making the assertion meaningless. Found by
tracing the actual bytes each encoding step produces rather than trusting the variable's name; the
confusing middle case was removed rather than worked around, leaving a clean reject→reject→solve
sequence (literal, then the genuine double-encoded bypass).


## Update — Batch 8 (business logic & races)

8 labs. One test-authoring mistake caught before commit: the workflow-skip test asserted that
calling `/complete` before `/pay` would be refused (409) even on the intended "legitimate flow"
path — but that lab's whole point is that no such check exists; the assertion described a
protection the lab deliberately doesn't have. Fixed by removing the incorrect assertion rather than
adding a check to the lab to make the test pass. Separately, two integration tests across this
project (none before this batch) had been using API port 4190 for their control-plane instance,
which Node's `fetch` refuses to connect to under the WHATWG Fetch "bad port" list (a security
restriction, not a bug) — caught immediately via Node's own error message and fixed by moving to
port 4191.

All three race-condition labs are verified with ACTUAL concurrent HTTP requests
(`Promise.all([...])`), not a mocked or simulated race, and each test also proves a correctly-
handled sequential retry does NOT solve the lab — demonstrating the bug is specifically about
concurrency, not merely about the endpoint being reachable twice.


## Update — Batch 9 (API security)

9 labs. Two real bugs caught by tests before commit, both fixed in the lab rather than worked
around in the test:
- **websocket-chat-origin-cswsh**: the Origin check ran correctly, but `reportSolve()` was fired
  with `void` (fire-and-forget) from a non-async WebSocket handler, racing against the test's own
  check of whether the lab had solved — the client could receive its "welcome" message and the test
  could check `solved()` before the solve report's own HTTP call had completed. Fixed by making the
  handler `async` and `await`-ing `reportSolve()` before sending the welcome frame, so the connection
  is only ever usable after the solve is actually recorded, eliminating the race rather than paper
  ing over it with a delay in the test.
- **api-pagination-authz-gap**: the test's own fixture data interleaved two users' tickets, which
  meant even the lab's DEFAULT (correctly-scoped, by design) page already mixed owners — there was
  no way to demonstrate "normal use works correctly" at all. Fixed by reordering the seed data so a
  user's tickets are contiguous (as a real creation-time-ordered table plausibly would be), which
  changes nothing about the vulnerable code path itself, only the data layout needed to prove the
  before/after contrast cleanly.

Both GraphQL labs run the real `graphql` npm package end to end (parsing, validation, execution,
introspection) — nothing about GraphQL itself is simulated, only the business data.


## Update — Batch 10 (modern / bug-bounty-relevant categories)

8 labs, requested directly: after finishing API security, build out the vulnerability categories
most reported in current bug bounty programs that the catalogue didn't yet cover. Three real bugs
caught by tests before commit, each fixed properly rather than worked around:

- **mp-prototype-pollution-admin**: the test's own exploit payload was built with
  `JSON.stringify({ __proto__: {...} })` — but `{ __proto__: X }` as a JS object-literal is special
  syntax that sets the object's actual prototype rather than creating an own `"__proto__"` property,
  so it serialized to `"{}"`. Fixed using computed-property syntax, `{ ["__proto__"]: X }`, which
  produces a real own property and the literal JSON the lab's own `deepMerge` needs to be exploited.
- **mc-host-header-reset-poisoning**: both the lab's design and the first test attempt assumed a
  "real" domain string that nothing in this environment would ever naturally match, so even an
  ordinary, non-forged request already "solved" it. Fixed by making the lab's notion of its own
  correct host dynamic (the address it's actually running on) rather than a fixed, meaningless
  placeholder — and separately discovered that `fetch()` silently drops a manually-set `Host` header
  (a Fetch-spec restriction shared with real browsers), so the test was rewritten with `node:http`,
  which can genuinely set it, the same way Burp Repeater does.
- **xp-svg-upload-stored-xss**: the first version embedded uploaded SVGs via `<object>`, which does
  execute the SVG's script — but inside an isolated nested browsing context with its own `document`,
  unable to reach the parent page's `data-token` element. Fixed by inlining each SVG's raw markup
  directly into the gallery page's own HTML instead, which runs the script in the same document and
  is also a more realistic match for how this bug class is usually reported in the wild.

## Update — Nov 2026 audit for the "Advanced Real-World Bug Bounty Expansion" spec (Batch 1: audit, fixes, docs)

Scope of this pass: audit the existing 80-lab repository, fix what is broken, correct the documentation,
and add regression tests. **No new labs were added.** Everything below says how it was established.

### Findings (numbered N1–N9 to stay distinct from the F-numbers above)

| # | Severity | Finding | How established | Status |
|---|---|---|---|---|
| N1 | High | **Fresh clone: `npm install && npm run dev` crashes** (`ERR_MODULE_NOT_FOUND`, `@nulllab/orchestrator/dist/index.js`). The same missing-`dist/` problem breaks `npm run test:unit` (`Failed to resolve entry for package "@nulllab/shared"`), the integration suite and the Playwright e2e API server. Only CI and the Docker image built first. | Reproduced from a clean extraction; reproduced the test failure with `dist/` removed | Fixed: `build:libs` chained inside `dev`/`build`/`test:*`. Verified: from a state with no `dist/`, `npm run dev` starts, a guest logs in and a lab launches; `npm run test:unit` passes. Guarded by `tests/unit/repo-scripts.test.ts` (fails 6/7 against the old `package.json`) |
| N2 | Medium | A `predev`/`pretest` hook cannot be the fix: `.npmrc` sets `ignore-scripts=true`, and npm then skips pre/post hooks | Tested: marker file written by `predev` is absent with the repo `.npmrc`, present with `--ignore-scripts=false` | Documented; the regression test forbids load-bearing pre/post hooks while `ignore-scripts=true` |
| N3 | Medium | README claimed "20 working labs across 3 families" and "the three XSS labs" use the admin-bot control; actual: 80 labs, 11 families, 7 browser-verified labs | Counted from manifests | Fixed |
| N4 | Low | Difficulty has 5 levels in manifests (beginner 4, easy 13, medium 39, hard 23, advanced 1); the spec speaks of 3 tiers (or beginner/intermediate/advanced) | Counted from manifests | **Closed by decision (project owner): keep the 5 levels.** Documented in CONTRIBUTING.md; XP is 50/75/125/200/300 |
| N5 | Low | 9 original labs (IDOR ×3, SQLi ×3, XSS ×3) have no `hints` list, only a single legacy `solutionHint`; 9 labs have no `burpNotes`; 11 labs have 2 hints, 60 have 3 | Counted from manifests | **Accepted by decision (project owner): leave as is.** The spec's "progressive hints" requirement is therefore met by 71 of 80 labs; the 9 originals remain single-hint |
| N6 | Medium | **No lab had been proxy- or Burp-tested** (already disclosed in F11). Tests used plain Node HTTP clients; no HTTPS target; no test routed through a proxy | `grep` of `tests/` for proxy/Burp/HTTPS usage | **Partly addressed** by the proxy harness (see "Proxy harness" below): 73 of 80 labs were proxy-verified at that point, 86 of 93 after Batch 2. **Still open:** nothing has been run in Burp Suite itself; the 7 browser-triggered labs are not routed through the proxy; no HTTPS |
| N7 | Medium | `process-runtime` spawns `node_modules/.bin/tsx.cmd` on Windows without `shell: true`; Node ≥ 20.12 refuses to spawn `.cmd` files that way, and the lab env passes only `PATH` | Code reading + known Node behaviour. **Not run** (no Windows host here) | **Open**, not changed (untestable here). README already directs Windows users to WSL2/Docker |
| N8 | Info | Docker mode (`RUNTIME_MODE=docker`) and `docker compose up` remain unexercised: no Docker daemon in the sandbox | — | **Open** (unchanged since F1–F4) |
| N9 | Medium | With no `.env`, `npm run dev` starts Vite but the API exits (`SESSION_SECRET: Invalid input: expected string, received undefined`), which looks like "labs won't run" and gave no hint how to fix it | Reproduced on a fresh extraction that had no `.env` | Fixed: the error now tells the user to `cp .env.example .env`; README troubleshooting entry; `tests/unit/env-config.test.ts` (fails when the hint is removed) |
| N10 | Low | `npm run typecheck` never type-checked `tests/` or `scripts/` (`tsconfig.json` has `files: []`; labs are checked separately). Pre-existing errors turned up in files touched during this pass | One-off strict `tsc` run, then over all of `tests/` and `scripts/` | **Fixed as a ratchet** (owner chose "new files only"): `tsconfig.tests.json` is part of `npm run typecheck`, checks every test and script file, and excludes only `tests/unit/instance-manager.test.ts` (2 errors: it imports `PortAllocator` from `src/` while the code under test expects the compiled package's type; no runtime effect). That file was left unfixed on purpose. All other test/script files pass. `repo-scripts.test.ts` fails if the exclusion list grows or goes stale; `@types/ws` was added |

### Isolation audit (static + test evidence)

- `labs/` and `packages/lab-sdk/src` contain no `child_process`, `eval`, `new Function` or `node:vm` use (grep; the `.exec(` hits are regex/SQLite calls).
- No lab reads or writes the real filesystem (`readFile*`, `createReadStream`, `writeFile*`, `rm*` — no matches in `labs/`). Traversal/LFI/zip-slip labs run against an in-memory virtual filesystem.
- All SSRF labs fetch through `MockInternalNet`, which never opens a socket or resolves DNS (documented in its header, covered by `tests/unit/mock-internal-net.test.ts`). The `fetch(` calls found in other labs are browser-side JavaScript inside served pages.
- Not covered by this pass: a line-by-line review of all 80 `server.ts` verifiers. Their behaviour is evidenced by the lab-contract test (all 80) plus a dedicated exploit test that names each lab (80/80 labs referenced by a non-contract test file); a line-level review is still outstanding.

### Inventory (from manifests)

80 labs: access-control 15, injection 13, auth-session 10, api-security 9, server-logic 8, ssrf 8, client-side 7,
file-handling 6, misconfiguration 2, modern-platform 1, xml-parsers 1. 7 require the browser admin bot
(`clickjack-admin-action`, `xss-dom-hash-sink`, `xss-reflected-search`, `xss-stored-review`, `xss-stored-ticket`,
`mp-prototype-pollution-admin`, `xp-svg-upload-stored-xss`). Three labs return 404 at `/` by design —
`ssrf-cloud-metadata-widget`, `sl-deserialization-trusted-types`, `sl-mass-assignment-profile` are driven through
`POST`/`PATCH` endpoints. `docs/coverage-matrix.md` and `docs/lab-catalogue.md` were regenerated and showed no drift.
`docs/lab-verification-status.json` lists all 80 labs, each with an existing test file that mentions the lab id.
Its `testsPassing: true` is hand-maintained, not derived from a test run.

### Gap analysis against the new spec (sections 3A–3K)

Mapping is from manifests (id, objective, vulnerable endpoint), not from re-reading every server.
"Partial" means an existing lab touches the theme but not the spec item as written.

| Spec area | Already present | Not present yet |
|---|---|---|
| A. Access control | ac-tenant-header, ac-nested-object, ac-bfla-remove-member, ac-bopla-fields, ac-bulk-export-no-scope, ac-workflow-edit-after-approval, graphql-staff-field-authz (partial: GraphQL vs REST) | invitation privilege escalation, ownership transfer, role inheritance, permission up/downgrade, GraphQL mutation authz, email/phone change authz, cross-account document sharing, async-job authz, multi-step approval chains, ownership change after check |
| B. Business logic | sl-price-client-trusted, sl-price-negative-quantity, sl-workflow-skip-payment, sl-race-coupon-reuse, sl-race-giftcard-overdraft, sl-race-inventory-oversell | refunds (duplicate/unauthorised/amount), coupon stacking, referral abuse, subscription up/downgrade, trial extension, payment verification bypass, rounding/currency, booking abuse, discount eligibility, transaction replay, partial completion |
| C. Info disclosure | fh-backup-file-exposure, api-excessive-data-exposure, api-key-leaked-in-logs, sqli-error-based (verbose errors, partial) | source maps, bundle secrets, frontend API keys, debug endpoints, private document/invoice exposure, metadata leakage, storage ACL mistakes, hidden endpoint discovery, search/autocomplete leakage |
| D. Auth / OAuth | auth-jwt-alg-none, auth-jwt-weak-secret, auth-logout-doesnt-invalidate, auth-mfa-step-skip, auth-no-rate-limit-login, auth-oauth-redirect-uri, auth-remember-me-predictable, auth-reset-predictable-token, auth-session-fixation, auth-username-enumeration, mc-host-header-reset-poisoning | OAuth account linking, missing `state`, PKCE mistakes, callback confusion, email-verification bypass, recovery-code reuse, MFA recovery bypass, session after password change, revocation inconsistency, alternate-identifier recovery, login/registration races, IdP trust (local mock IdP needed) |
| E. API security | api-mass-assignment-order, api-version-inconsistency, api-pagination-authz-gap, api-key-no-rate-limit, graphql-staff-introspection, websocket-chat-origin-cswsh | GraphQL batching/aliases, REST method/content-type inconsistencies, API key scopes, webhook signature bypass/replay, batch-request authz, async job access, WebSocket message-level authz and session expiry |
| F. SSRF | 8 labs: logo fetch, link-preview redirect, blocklist IP encoding, substring bypass, cloud-metadata widget, PDF resource fetch, webhook destination, blind callback | DNS-resolution mistakes, IPv6 normalisation, URL-parser disagreement, wider allow/blocklist inconsistencies |
| G. Misconfiguration / caching | mc-host-header-reset-poisoning, mc-http-parameter-pollution, cors-reflect-credentials | cache poisoning, web cache deception, cache-key confusion, unkeyed headers, CORS edge cases, CSP misconfiguration, exposed internal routes, debug endpoints, directory listing, default credentials, reverse-proxy inconsistencies |
| H. Browser-side | xss-reflected-search, xss-stored-review, xss-stored-ticket, xss-dom-hash-sink, clickjack-admin-action, open-redirect-login-next | CSRF (designed earlier, not built), weak CSRF tokens, SameSite mistakes, postMessage origin (designed, not built), other DOM sinks, CSP weaknesses, service-worker scope, open-redirect chains |
| I. XML / uploads | xp-svg-upload-stored-xss, fh-upload-extension-bypass, fh-zip-slip-extract, fh-path-traversal-download, fh-encoded-traversal, fh-lfi-template-include | XXE (basic + blind), parser configuration mistakes, content-type validation bypass, filename normalisation, upload-driven file overwrite, document preview/rendering |
| J. Advanced injection / platform | mp-prototype-pollution-admin, nosql-operator-injection, ssti-mock-template, sl-deserialization-trusted-types | HTTP request smuggling (needs a dedicated raw proxy/backend), more pollution paths, more NoSQL/SSTI engines, supply-chain/CI-CD exposure, integrity-validation mistakes |
| K. AI app security | none | all (needs deterministic mock model + mock retrieval) |

### Proxy harness (this pass)

`tests/integration/proxy.ts` is a local HTTP/1.1 forward proxy; with `NULLLAB_TEST_PROXY=1` (`npm run test:proxy`)
every learner-side request the integration suite sends to a lab goes through it: `CookieClient`, the older tests'
bare `fetch()` (wrapped in `proxy-setup.ts`), the forged-`Host` helper (`rawRequest`) and WebSocket handshakes (a
`CONNECT` tunnel). It forwards only to loopback lab ports (anything else gets a 403), and records per-lab traffic.

| Check | Result |
|---|---|
| Harness self-tests (`proxy-harness.test.ts`) | 21 passed. Deliberately breaking the proxy (open allowlist, Host overwritten, duplicate cookies collapsed, redirect method rewrite removed, port-recycling accounting) made the matching tests fail each time |
| Whole integration suite through the proxy | 206 of 206 passed (119 across 18 files + 87 in the lab-contract test), plus the 21 harness tests; run file by file, with the stand-in Chromium for browser-driven labs. Between roughly 2,000 and 7,600 proxied HTTP requests per full run (it varies: the brute-force lab `api-key-no-rate-limit` seeds a different key per instance, so its search length changes), 3 `CONNECT` tunnels, 0 blocked |
| Labs proxy-verified (solved within one test file with all learner traffic proxied) | **73 / 80**, generated into `docs/lab-verification-status.json` by `npm run proxy:status -- --write` and re-checked by `npm run test:proxy` |
| Not counted (7) | `clickjack-admin-action`, `mp-prototype-pollution-admin`, `xp-svg-upload-stored-xss`, `xss-dom-hash-sink`, `xss-reflected-search`, `xss-stored-review`, `xss-stored-ticket`: the exploit executes in a real Chromium (the admin bot) that is not routed through the proxy, and a URL-fragment payload is never sent over HTTP at all |

Things the harness work uncovered:
- Many older tests call the global `fetch()` directly, not `CookieClient`; routing only `CookieClient` silently left
  `sqli-product-search` and `sqli-blind-report` "solved" with **zero** proxied requests. Proof is therefore required
  per test file (solved *and* proxied traffic in the same file); merging traffic from one file with a solve from
  another would have over-claimed.
- Through a proxy, a stopped lab answers `502` instead of refusing the connection. The harness therefore stops
  proxying a port once the control plane marks its instance stopped, so the contract test's "stopped lab no longer
  answers" assertion is unchanged.
- Node's `fetch` cannot send a forged `Host`; the raw-`http` path in the proxy client can, so the Host-header
  poisoning lab is exercised through the proxy with its forged Host intact.

Still **not** done: running any lab in Burp Suite itself; routing the admin-bot Chromium through the proxy (Chromium
exempts loopback unless started with `--proxy-bypass-list="<-loopback>"`); HTTPS; a single-command timing of
`npm run test:proxy` (it exceeds my sandbox's per-command limit, so it was run in pieces).

## Batch 2 — advanced access control & account takeover (13 new labs)

The catalogue grew from 80 to 93 labs. Each lab is a separate app with its own root cause; none reuses an
existing mechanism (checked against the weakness statements of every existing access-control and API lab,
e.g. `ac-nested-object`, `ac-tenant-header`, `ac-method-switch`, `api-version-inconsistency`, the two GraphQL labs).

| Lab | Difficulty | Spec bullet (section 3A) | Root cause |
|---|---|---|---|
| `ac-invite-role-escalation` | medium | organization invitation privilege escalation | invite role validated for existence and "no owners", never against the inviter's own role |
| `ac-ownership-transfer-collaborator` | medium | unauthorized ownership transfer | transfer checks project *membership*, not ownership (sibling endpoints check correctly) |
| `ac-email-change-body-identity` | medium | unauthorized email / phone modification | "integrity check" compares the URL id with a client-supplied body field, not the session |
| `gql-mutation-guard-gap` | hard | authorization bypass through GraphQL mutations | role-check wrapper applied to the Query resolvers only; introspection disabled |
| `ac-job-runas-confused-deputy` | hard | authorization bypass in asynchronous jobs | worker authorizes for a `runAs` identity the enqueue endpoint copies from the client |
| `ac-download-signing-oracle` | hard | unauthorized access through export and download endpoints | link-signing endpoint signs any existing file id; the signed link needs no session |
| `ac-role-inheritance-upward` | hard | role inheritance mistakes | effective-role resolver counts descendant grants as well as ancestors; write path reuses it |
| `ac-downgrade-stale-claim` | medium | permission downgrade flaws | writes authorized from the role claim in the signed cookie, not the current record |
| `ac-approval-step-skip` | medium | multi-step approval authorization bypass | finance step checks "is an approver", not "is finance" |
| `ac-ownership-toctou-share` | advanced | resource ownership changes after authorization checks | check, slow scan, write without re-check; solved only by genuinely overlapping requests |
| `ac-clone-cross-tenant` | medium | cross-tenant resource access through nested APIs | import action's *source* project id is looked up globally (the read path is correct) |
| `ac-method-override-admin` | medium | administrative actions exposed through alternate endpoints | guard keyed on the HTTP method; `X-HTTP-Method-Override` applied inside the handler |
| `ac-share-accept-unbound` | easy | cross-account document sharing | accept-by-sequential-id never checks the share was addressed to the caller |

**Not built, deliberately** (13 of the 15 bullets): *inconsistent authorization between REST and GraphQL* would
overlap `graphql-staff-field-authz` and `gql-mutation-guard-gap`; *account and organization membership manipulation*
and the *upgrade* half of "permission downgrade and upgrade flaws" are covered only indirectly (invitations; the
downgrade lab). They are the first candidates for a later pass.

| Check | Result |
|---|---|
| New lab tests (`advanced-access-control.test.ts`) | 13 of 13 pass, in normal mode and through the proxy |
| Verifiers sabotaged on purpose (always report a solve) | 12 of the 13 labs were sabotaged, and the matching test failed every time, so those tests depend on the real condition. The 13th (`gql-mutation-guard-gap`) was not sabotaged; its test instead found a genuine verifier bug (next row) |
| Defect found by the tests | `gql-mutation-guard-gap` initially missed the case where a user promotes *themselves* (the mutation changed the caller's role before the verifier read it); fixed by reading the caller's role first |
| Contract test (static + per-lab runtime) | passes for all 93 labs, in normal mode and through the proxy |
| Proxy harness | 86 of 93 labs proxy-verified (73 + all 13 new); the 7 browser-triggered labs are still excluded |
| Type-check ratchet | caught a type error in the first draft of the new test file (non-generic `jsonPost`); fixed by making the helper generic |

Every new lab also meets the contract's per-lab requirements (unique weakness, hints with solution words only in
the last one, seeded data, working reset/stop). None needs the admin bot, so none is browser-triggered. Still **not**
done for these labs: Burp Suite itself (only the proxy harness), HTTPS, Docker, and a line-by-line security review of
the new servers beyond their tests.

## Batch 3 — business logic, payments & races (13 new labs)

The catalogue grew from 93 to 106 labs. Existing server-logic labs (price and quantity tampering, workflow skip,
same-account coupon race, gift-card overdraft race, inventory oversell race, mass assignment, deserialization) were
read first; none of the new root causes repeats one. The closest, duplicate refunds, differs on purpose: its flaw is
an idempotency key and a refunded total recorded only *after* a slow gateway call, in a refund domain, not a balance check.

| Lab | Difficulty | Spec bullet (section 3B) | Root cause |
|---|---|---|---|
| `sl-refund-idempotency-race` | hard | duplicate refund processing | idempotency key and refunded total written after the slow network call; overlapping requests all pass the checks |
| `sl-refund-ignores-discount` | medium | refund amount manipulation | refund = list price x qty; the order-level discount is never applied |
| `sl-refund-to-wallet-bola` | medium | unauthorized refund initiation | eligibility checked, ownership not; the *caller's* wallet is credited |
| `sl-coupon-stacking-slots` | medium | coupon stacking | "one code" enforced per slot (promo / loyalty); checkout adds the percentages, 30% policy not enforced |
| `sl-coupon-per-account-reuse` | easy | coupon reuse across accounts | one-time rule checked per account, not per code; registration is open |
| `sl-referral-reward-unpaid` | medium | referral reward manipulation | reward fires on order *creation*, never reversed on cancel |
| `sl-subscription-cycle-entitlement` | hard | subscription downgrade and upgrade abuse | entitlement immediate, billing at renewal for the plan held that day |
| `sl-payment-return-status-tamper` | medium | payment verification bypass | return-URL signature covers order and amount, not the status the shop then trusts |
| `sl-topup-confirmation-replay` | easy | transaction replay | valid signed confirmation never marked consumed |
| `sl-race-checkout-cart-mutation` | advanced | race conditions across related endpoints | checkout totals the cart, authorizes (slow), then builds lines from the live cart; add-to-cart is not locked |
| `sl-transfer-partial-completion` | medium | partial transaction completion | credit applied first, debit refused later with 402, credit never undone |
| `sl-currency-rounding-arbitrage` | medium | currency conversion and rounding errors | round-up in both directions, no fee, 1-cent minimum; tiny round trips accumulate |
| `sl-giftcard-self-transfer` | medium | gift-card transfer and balance abuse | independent copies written back; when source = destination the subtraction is lost |

**Not built, deliberately** (13 of the 19 bullets): *free trial extension abuse*, *duplicate payment and order
creation*, *reservation and booking workflow abuse*, *discount eligibility manipulation* and *state-transition bypass*
(partly covered by `sl-workflow-skip-payment`), and *quantity and inventory manipulation* (partly covered by
`sl-price-negative-quantity` and `sl-race-inventory-oversell`). Sketched and ready for a later pass: trial restart after
cancel; two orders from one captured payment; a per-reservation instead of per-user seat limit; student discount decided by
a request-supplied billing email; cancelling an order after it shipped while keeping the refund.

| Check | Result |
|---|---|
| New lab tests (`business-logic-batch.test.ts`) | 13 of 13 pass, in normal mode and through the proxy |
| Race labs | only genuinely overlapping requests solve them (`Promise.all` with a deliberate offset); sequential runs of the same requests do not; assertions are on resulting state (refunded total above paid; order items worth $73 more than authorized) |
| Verifiers sabotaged on purpose (always report a solve) | all 13 sabotaged; 12 were caught immediately |
| Defect found by that exercise | `sl-transfer-partial-completion` checked "money was created" only inside the refused-transfer branch, where it is always true, so sabotaging it changed nothing and no test could tell. The invariant is now checked after every transfer; re-sabotaged, it is caught |
| Contract test (static + per-lab runtime) | passes for all 106 labs, normal mode and through the proxy |
| Proxy harness | 99 of 106 labs proxy-verified (73 + 13 + 13); the same 7 browser-triggered labs are excluded |
| Hygiene | lint 0 errors and 0 warnings (three unused imports in the new labs were removed); tests/scripts type-check passes with no new exclusions |

Still **not** done for these labs: Burp Suite itself (only the proxy harness), HTTPS, Docker, and a line-by-line security
review of the new servers beyond their tests. These apps are deliberately vulnerable and in-memory; none touches the host,
the network or the filesystem.

## Batch 4 — information disclosure & API security (13 new labs, new family)

The catalogue grew from 106 to 119 labs, adding an `information-disclosure` family (the spec's section C)
alongside 7 more api-security labs (section E). Existing labs in both areas (`fh-backup-file-exposure`,
`api-excessive-data-exposure`, `api-key-leaked-in-logs`, `graphql-staff-field-authz`,
`graphql-staff-introspection`, `websocket-chat-origin-cswsh`, `api-mass-assignment-order`,
`api-version-inconsistency`, `api-pagination-authz-gap`, `api-key-no-rate-limit`) were read first; none
of the 13 new root causes repeats one.

**Design decision carried through all six discovery-style labs:** finding the leaked secret — reading a
source map, a bundle config file, a debug endpoint, a verbose error, an export, or a storage listing — is
never enough on its own. Every verifier fires only once that secret is actually used against a protected
endpoint to do something only it can do, and every test proves the "discovery alone" step first does
*not* solve the lab.

| Lab | Difficulty | Spec bullet | Root cause |
|---|---|---|---|
| `id-sourcemap-internal-token` | medium | source map exposure | production source map reconstructs source containing an internal API token |
| `id-frontend-secret-key` | easy | API key exposure in frontend assets | a dev-only config file with an upstream API key shipped as a public static asset |
| `id-debug-endpoint-signing-secret` | medium | debug endpoint exposure | an unguarded `/debug/*` namespace echoes the service's own HMAC signing secret |
| `id-verbose-error-service-token` | medium | verbose exception disclosure | a client's exception message includes the request it was about to send, auth header included |
| `id-export-leaks-reset-tokens` | medium | user data exposure through exports | a manager CSV export selects every column, including one-time password-reset tokens |
| `id-storage-bucket-listing` | medium | cloud storage access-control mistakes | unguessable per-object keys, but the bucket's list operation is open to anyone |
| `api-webhook-signature-optional` | medium | webhook signature validation bypass | verification runs only `if a signature header is present`; an absent header skips it entirely |
| `api-key-scope-by-verb` | medium | API key scope and permission mistakes | a read-only key's scope check matches the request PATH only, never the HTTP method |
| `gql-batching-rate-limit-bypass` | hard | GraphQL batching abuse | a lockout counter increments once per HTTP POST, blind to how many operations one POST bundles |
| `gql-alias-cost-abuse` | hard | GraphQL alias-based query abuse | a cost limiter counts distinct field NAMES, so one field aliased many times is still "1" |
| `api-content-type-validation-bypass` | medium | REST method and content-type inconsistencies | a field allow-list runs only on the `application/json` branch; a `text/plain` fallback has none |
| `api-batch-endpoint-authz-skip` | medium | batch request authorization gaps | a bulk-update endpoint checks that each id exists, never that it belongs to the caller |
| `ws-message-level-authz` | hard | WebSocket message-level authorization failures | room membership is checked once at connect; a later message names any room with no re-check |

**Not built, deliberately** (6 of the 19 combined bullets): hidden-endpoint discovery and cross-user
search/autocomplete leakage (section C); GraphQL resolver-level authorization bypass and mutation
privilege escalation (closely related to `gql-mutation-guard-gap` from Batch 2); webhook replay;
WebSocket session-expiration mistakes (`ws-message-level-authz` covers message-level authorization, not
expiry). Candidates for a later pass.

### Bugs this batch's own discipline caught (in my code, not the labs' intended lesson)

- `id-debug-endpoint-signing-secret` and `api-webhook-signature-optional` both computed
  `Buffer.from(sign(payload))` — a hex-digest **string** without `"hex"` encoding, so Node reads it as
  UTF-8 and compares a 64-byte buffer against the real 32-byte signature. Every signature, right or
  wrong, failed verification. Caught because the exploit test for the first lab asserted a *correct*
  signature must succeed, and failed instead. Fixed in both files.
- Sabotaging each verifier to "always report a solve" caught 11 of 13 immediately. Two needed a real
  near-miss added first, because no existing test step could tell the real condition from `if (true)`:
  - `id-export-leaks-reset-tokens` keyed its check on "is the caller's session the same as the account
    being reset" — but password reset is an unauthenticated flow by nature, so that condition was already
    true for the intended exploit even without the mutation. Redesigned to track, per account, whether its
    token has ever appeared in an export response, independent of who later uses it; added a genuine
    self-service reset (the account's own, never-exported token) as the near-miss.
  - `api-webhook-signature-optional`'s condition required `plan === "pro"`, but every test call either
    failed earlier (bad signature, missing field) or was the exploit itself — nothing exercised the line
    with the plan still at "basic". Added an unsigned, non-activating event as the near-miss.
- `ws-message-level-authz`: the handler sent the WebSocket reply before `await`-ing `reportSolve`, so a
  test reading the reply could see `lab.xp()` unchanged a moment before the solve was actually recorded.
  Reordered to await the report first.
- The WebSocket "connection refused" case needed its own fix on the TEST side: a client's `open` event
  fires as soon as the handshake completes, before the route handler's own authorization check has had a
  chance to call `socket.close()` — so a promise that resolves on `open` alone can never observe a
  same-tick rejection. The connect helper now waits briefly after `open` before accepting it.

| Check | Result |
|---|---|
| New lab tests (`info-disclosure-api-batch.test.ts`) | 13 of 13 pass, in normal mode and through the proxy (including the WebSocket lab's CONNECT tunnel) |
| Verifiers sabotaged on purpose (always report a solve) | all 13 sabotaged; 11 caught immediately, 2 fixed and re-confirmed caught (above) |
| Contract test (static + per-lab runtime) | passes for all 119 labs, normal mode and through the proxy |
| Proxy harness | 112 of 119 labs proxy-verified (99 + all 13 new); the same 7 browser-triggered labs excluded |
| Hygiene | strict `tsc` over the changed test file passes with no new exclusions; lint 0 errors / 0 warnings |

Still **not** done for these labs: Burp Suite itself (only the proxy harness), HTTPS, Docker, and a
line-by-line security review of the new servers beyond their tests.

### Tests executed in this pass (actual results)

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` | pass |
| Unit tests (`tests/unit`) | 69 before this pass; `repo-scripts.test.ts` (+7) and `env-config.test.ts` (+3) bring it to 79 — see the final-gate row |
| Integration tests (`tests/integration`) | 206 passed across 19 files. Run **per file**, not as one command (the contract file alone takes ~160 s; the sandbox caps a single command). Without a browser, 7 tests fail (the browser-bot labs); they passed after pointing `NULLLAB_CHROMIUM_EXECUTABLE` at a Chromium binary distributed through npm, used for this run only |
| E2E (`tests/e2e`, Playwright) | 5 passed, same Chromium |
| 80-lab launch sweep through the API (`npm run dev` path) | 80/80 reached `running`; each lab's URL then answered HTTP (47 × 200, 30 × 302, 3 × 404 — see above) |
| Regression test for N1/N2 | passes with the fix; fails 6 of 7 against the original `package.json` |

### Not verified in this pass

Docker / Compose; native Windows; WSL2 specifically (the sandbox is plain Linux); HTTPS targets; any proxy or Burp
session; a full single-command `npm run test:integration` run; a line-by-line review of every lab server.

### Final gate for the proxy-harness work (fresh extraction of the packaged zip)

| Check | Result |
|---|---|
| `npm ci`, typecheck, lint, build | pass; generated docs show no drift |
| Unit tests | 92 of 92 |
| Integration, normal mode | 206 of 206 (119 across 18 files + 87 contract), plus 21 proxy-harness tests |
| Integration, through the proxy (`vitest.proxy.config.ts`) | 206 of 206, plus the 21 harness tests; run file by file |
| `npm run proxy:status` against the committed status file | "Status file matches the proxy run" (73 of 80) |
| E2E (Playwright) | 5 of 5 |

Same caveats as above: the browser-driven labs ran with a stand-in Chromium; `npm run test:proxy` was run in
pieces because the sandbox caps a single command's time; nothing was run in Burp Suite, Docker, native Windows or
over HTTPS.
