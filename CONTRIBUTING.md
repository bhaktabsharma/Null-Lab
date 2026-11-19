# Contributing to NULLLAB

Thanks for considering it. The most valuable contribution by far is a new,
genuinely-working lab — the sections below walk through that.

## Project layout

```
apps/api        control-plane API (Fastify) — accounts, catalogue, instance
                 lifecycle, the verifier's internal endpoints
apps/web        control-plane frontend (React + Vite)
packages/shared vulnerability taxonomy, lab manifest schema, API types
packages/lab-sdk the contract every lab target uses: reportSolve(), a
                 session helper, a tiny HTML shell, the admin-bot session
                 helper for XSS-style labs
runtime/orchestrator process-mode and Docker-mode runtime backends
labs/<family>/<lab-id>/   one folder per lab: manifest.json + server.ts
tests/unit, tests/integration   the automated test suite
```

See `docs/architecture.md` for how these fit together, and
`docs/coverage-matrix.md` (generated — see below) for what's implemented
versus still planned.

## Adding a new lab

1. **Pick (or add) a taxonomy subcategory.** `packages/shared/src/taxonomy.ts`
   lists every vulnerability family and subcategory NULLLAB tracks. If
   yours doesn't exist yet, add it there first.
2. **Create `labs/<family>/<your-lab-id>/manifest.json`.** Copy the shape
   from an existing lab in the same family — `id`, `title`, `objective`,
   `family`, `subcategory`, `difficulty` (one of `beginner`, `easy`, `medium`,
   `hard`, `advanced` — five levels on purpose, worth 50/75/125/200/300 XP; see
   `packages/shared/src/xp.ts`), `verifier.condition`, plus the
   fields the contract test requires of every lab: `weakness` (the ONE thing
   it teaches — must be unique), `vulnerableEndpoint`, `seededData`, at
   least one entry in `hints` (progressive; only the LAST may be explicit),
   `spoilers` (exact strings — hidden paths, parameter/cookie names,
   payload fragments — that must never appear in anything a learner always
   sees or in a non-final hint), and `burpNotes`. Then (only
   for labs whose proof requires the headless-browser admin bot, i.e.
   stored/reflected XSS-style labs) `verifier.requiresBrowserBot: true`
   plus `verifier.adminCookieName`.
3. **Write `labs/<family>/<your-lab-id>/server.ts`.** For session-style
   labs, `makeSessions()` + `registerPasswordLogin()` (also in the SDK)
   give you instance-scoped signed cookies and the login routes, so the
   file contains only your flaw. Use
   `createLabApp()` / `startLabApp()` from `@nulllab/lab-sdk` to get a
   Fastify app with cookies and a `/healthz` route for free. Build a
   believable small app around your vulnerability — real HTTP routes,
   real request/response bodies, synthetic data.
4. **Call `reportSolve(ctx, evidence)` from inside the actual vulnerable
   handler**, at the exact point your own code has honestly determined
   the security invariant was broken (e.g. "the record returned belongs
   to a different user than the session"). Never report a solve based on
   anything the client merely claims. See any existing lab's "the
   vulnerable handler" comment for the pattern.
5. **Add a negative test and a positive (exploit) test** in
   `tests/integration/` — `tests/integration/access-control-batch1.test.ts`
   plus `lab-harness.ts` (`launch`, `formLogin`, `expectSolvedOnce`) show the
   shape: ordinary use must NOT solve, near-misses must NOT solve, the real
   exploit solves once, and a repeat awards no extra XP. The generic
   `lab-contract.test.ts` picks your lab up automatically — and
   `npm run typecheck` type-checks lab sources too. Following the shape of
   an existing test file —
   `startTestApp()` spins up the real control plane and spawns your lab
   as a real process; drive it with plain `fetch()` or the `CookieClient`
   helper, exactly like a browser or Burp would. Give your test file its
   own, non-overlapping `apiPort` / `labPortStart`–`labPortEnd` range (see
   the top of any existing integration test file for the convention) so
   it can run alongside the others. If your test launches the lab with
   `launch()` / `startTestApp()` and talks to it with `CookieClient` or
   plain `fetch()`, it is also picked up by the proxy run
   (`npm run test:proxy`) with no extra work; for a forged `Host` use
   `rawRequest()` and for WebSockets `wsConnectOptions()` from
   `tests/integration/proxy.ts`, so they go through the proxy too.
6. **Record it in `docs/lab-verification-status.json`** once your tests
   actually pass, then run `npm run coverage:matrix` to regenerate
   `docs/coverage-matrix.md`. A lab manifest with no entry there shows up
   as "implemented, unverified" rather than silently looking covered —
   please don't add an entry you haven't actually verified. The
   `verifiedViaProxy` flag is the exception: don't type it — run
   `npm run test:proxy`, then `npm run proxy:status -- --write`.

## Before opening a PR

```
npm install
npm run typecheck    # also type-checks tests/ and scripts/ — a new file there must pass (see tsconfig.tests.json)
npm run test          # unit + integration
npm run test:proxy    # optional locally (slow); CI runs it — integration suite through the proxy harness
npm run test:e2e      # if you touched the frontend — see tests/e2e
npm run coverage:matrix
```

All of the above should pass, and `docs/coverage-matrix.md` should be
regenerated (it's checked in so reviewers can see it diff).

## Conventions

- TypeScript, strict mode, no `any` beyond what Fastify's own types
  require for request bodies.
- A lab target is a small, believable app, not a bare JSON API — give it
  a name, a shell/nav via `renderShell()`, and synthetic data that makes
  sense for the scenario.
- Never put the exploit answer in the lab's own UI. `solutionHint` in the
  manifest is a nudge, not a walkthrough.
- Keep each lab's data model self-contained (in-memory arrays are fine
  for most labs; use `openInstanceDb()` for a real SQLite database when
  the vulnerability is actually about the data layer, e.g. SQL
  injection).

## Reporting bugs / requesting features

Regular GitHub issues. For anything that smells like a security issue in
NULLLAB *itself* (not "this lab is vulnerable" — that's the point), see
`SECURITY.md` instead.
