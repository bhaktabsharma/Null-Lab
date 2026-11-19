# NULLLAB

**Practice over theory.**

An open-source, self-hosted lab platform for practicing real web
application security vulnerabilities against realistic, intentionally
vulnerable target apps — through its own built-in workspace or through
Burp Suite. No theory pages, no flag-submission boxes: a lab is marked
solved automatically, server-side, the moment you genuinely exploit it.

> **Local practice only.** Never expose NULLLAB, or any lab it launches,
> to the public internet. See [`SECURITY.md`](./SECURITY.md).

## What's here right now

A complete control plane, a real orchestrator, and **119 working labs**
across 12 vulnerability families, each with a genuine server-side verifier
and automated tests that actually exploit it. Difficulty mix: 4 beginner,
17 easy, 63 medium, 32 hard, 3 advanced. More families are being added in
tested batches — see the coverage matrix for exactly what exists.

| Family | Labs |
|---|---|
| Access control (IDOR/BOLA, BFLA, BOPLA, tenant isolation, workflow flaws, invitation / ownership / role escalation, GraphQL mutation authz, async jobs, signed URLs, check-then-act races) | 28 |
| Injection (SQLi ×7 variants, NoSQL, LDAP, XPath, SSTI, command, log/CRLF) | 13 |
| Authentication & session (JWT, MFA, OAuth redirect, session fixation, reset tokens) | 10 |
| API security (GraphQL incl. batching/alias abuse, WebSocket CSWSH and message-level authz, mass assignment, versioning, API keys/scopes, webhooks, content-type) | 16 |
| Business logic & races (price/quantity tampering, workflow skip, refunds, coupons and referrals, subscriptions, payment-return and replay flaws, rounding, partial transfers, real concurrency races, mass assignment, deserialization) | 21 |
| SSRF (simulated internal network only — never a real socket) | 8 |
| Client-side (XSS reflected/stored/DOM, clickjacking, CORS, open redirect) | 7 |
| File handling (traversal, LFI, upload bypass, zip-slip, backup exposure) | 6 |
| Misconfiguration (Host-header poisoning, HTTP parameter pollution) | 2 |
| Modern platform (prototype pollution) | 1 |
| XML & parsers (SVG upload stored XSS) | 1 |
| Information disclosure (source maps, frontend secrets, debug endpoints, verbose errors, exports, storage listings) | 6 |

Browser-dependent labs (stored/reflected/DOM XSS, clickjacking, prototype
pollution, SVG-upload XSS) are verified by a real headless-Chromium
"admin bot", not by guessing at a string.

Every lab also passes a shared **lab contract** (`tests/integration/lab-contract.test.ts`):
valid and unique manifest, one distinct weakness per lab, learner-facing
API that never reveals the exploit, healthy launch, unsolved start, working
reset and stop. Hints are served one at a time, on request. Maintainers can
see the lab-to-weakness map in [`docs/lab-catalogue.md`](./docs/lab-catalogue.md)
(it contains spoilers).

See [`docs/coverage-matrix.md`](./docs/coverage-matrix.md) for the full,
honestly-generated breakdown of what's implemented versus still on the
roadmap (dozens of other subcategories are catalogued in
[`packages/shared/src/taxonomy.ts`](./packages/shared/src/taxonomy.ts) but
intentionally not yet built — see that file's note on why).

## Quick start

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) and the
Compose v2 plugin (`docker compose version` should work). On Windows, use
Docker Desktop with the WSL2 backend; on Linux (including inside WSL2 or
Kali), install Docker Engine normally.

```bash
git clone <repository-url>
cd Null-Lab
cp .env.example .env
docker compose up --build
```

Then open **http://localhost:4000**. First build downloads a Chromium
browser for the XSS labs' verifier, so it can take a few minutes; after
that, startup is fast.

Compose publishes the control plane (`4000`) **and** the lab-target port
range (`5100`–`5199`) to your machine's **loopback only** — never to your
LAN. The lab URL the UI shows (e.g. `http://127.0.0.1:5100`) is reachable
from your browser and from Burp Suite. Once it's up, confirm everything
end to end:

```bash
npm run smoke        # logs in, launches a lab, runs a real exploit, checks the verifier, stops it
```

> **Verification status (be aware).** The Compose path was fixed in this
> revision (labs previously bound the container's own loopback with their
> ports unpublished, and the image lacked the `tsx` binary the process runtime
> needs). The fixes are covered by tests in process mode and by a simulation of
> the image's file layout, but **`docker build` / `docker compose up` itself
> has not been run by the author** (no Docker daemon in the build environment).
> `npm run smoke` is the check that tells you whether it works on your machine.

```bash
docker compose down          # stop
docker compose down -v       # stop AND delete all local data (accounts, progress)
docker compose logs -f       # follow logs
```

### Running without Docker (npm)

NULLLAB works perfectly well without Docker too — lab instances run as
isolated local processes either way (see
[`docs/architecture.md`](./docs/architecture.md) for what "isolated"
means in each mode). This is also the faster loop for development.
Requires **Node 20+** (22 recommended):

```bash
npm install
npx playwright install chromium   # one-time: the browser the XSS labs' verifier drives
cp .env.example .env
npm run dev           # API on :4000, frontend on :5173 — open the latter
```

`npm run dev` (and `npm run build`, `npm test`, `npm run test:e2e`) compile
the shared workspace packages first, so a fresh clone needs no manual build
step. The first run takes a few extra seconds; later runs are incremental.

**WSL2 / Kali:** keep the project inside the Linux filesystem (for example
`~/nulllab`), not under `/mnt/c/...` — it is much faster and avoids file-watch
and permission quirks. Open `http://localhost:5173` in your browser.

## Using a lab

Open a lab from the catalogue, hit **Launch lab**. You get:
- a running target at its own `http://127.0.0.1:<port>` — open it
  directly, or
- the same URL works as the target for **Burp Suite**: point your
  browser's proxy at Burp and browse to that address; every request —
  through the built-in view, Burp Repeater, curl, or anything else — hits
  the same real target and is verified the same way.

Demo credentials (when a lab has a login) are shown in the workspace.
Reset gives you a genuinely fresh instance — new process, new port, wiped
data — without losing XP you've already earned. For the 7 labs verified by a
real browser (XSS, DOM XSS, clickjacking, prototype pollution, SVG upload),
the workspace also has a **Simulate admin visit** control, since those
labs are verified by proving real script execution in a simulated
privileged session, not by you reading your own reflected input back.

## Testing with Burp Suite (or any intercepting proxy)

Every lab is plain HTTP on `http://127.0.0.1:<port>` — no HTTPS, no
host-based routing — so any intercepting proxy can sit in front of it.
These are standard proxy-setup points, not something this project has
verified against Burp itself:

- Burp's built-in browser works with loopback targets out of the box. For
  your own browser, make sure loopback isn't exempted from the proxy:
  Firefox needs `network.proxy.allow_hijacking_localhost` set to `true` in
  `about:config` (and an empty "No proxy for" list); Chrome/Chromium needs
  `--proxy-bypass-list="<-loopback>"`.
- curl: `curl -x http://127.0.0.1:8080 http://127.0.0.1:5100/` ·
  HTTPie: `http --proxy=http:http://127.0.0.1:8080 http://127.0.0.1:5100/`
  (adjust to your Burp listener and the lab's port).
- Burp on Windows with NULLLAB inside WSL2: WSL2 normally forwards
  `localhost` ports to Windows, so `http://127.0.0.1:<port>` should work from
  the Windows side; if it doesn't, use the WSL address instead.

**What has actually been tested.** `npm run test:proxy` re-runs the whole
integration suite with every learner-side request to a lab — including
WebSocket handshakes, via `CONNECT` — routed through a local forward proxy
(`tests/integration/proxy.ts`). It then checks that each lab was still *solved*
(by the server-side verifier) and writes the result to
`docs/lab-verification-status.json`. Today that is **112 of 119 labs**; the other
7 are the browser-triggered labs (XSS, DOM XSS, clickjacking, prototype
pollution, SVG upload), whose exploit runs in a real browser that is not
routed through that proxy. The harness is a generic HTTP proxy that behaves
like Burp's plain-HTTP listener: **no lab has been tested in Burp Suite
itself**, and the docs say "proxy harness", never "Burp verified".

## Commands

```bash
npm run dev              # local dev: API + frontend, both with hot reload
npm run build             # production build of every package
npm run build:libs        # compile only the shared workspace packages (run automatically by dev/build/test)
npm run test:proxy        # whole integration suite through the local forward proxy + status check
npm run proxy:status      # re-check the last proxy run against docs/lab-verification-status.json (--write to update)
npm run typecheck         # type-check the whole repo
npm run test               # unit + integration tests
npm run test:e2e          # Playwright browser tests (frontend)
npm run test:all           # everything
npm run db:reset           # wipe local accounts/progress (asks to confirm)
npm run coverage:matrix    # regenerate docs/coverage-matrix.md
npm run smoke              # end-to-end check against a RUNNING deployment (any mode)
npm run docker:selftest    # EXPERIMENTAL docker runtime: build, run, inspect, crash-recover
```

## Troubleshooting

- **The web page opens at :5173 but every request fails / the API isn't running.**
  Check the terminal for `[env] invalid configuration ... SESSION_SECRET`. You skipped
  `cp .env.example .env` (Vite still starts, the API exits). Run that command and start
  again; the error message now says so too.
- **`npm run dev` crashes with `ERR_MODULE_NOT_FOUND ... @nulllab/orchestrator/dist/index.js`
  (or `Failed to resolve entry for package "@nulllab/shared"` in tests).** The
  workspace packages weren't compiled. Current scripts do this automatically; if you
  see it (older checkout, or you ran `tsx`/`vitest` directly), run
  `npm run build:libs` once. Note: a `predev`-style hook would **not** work here,
  because `.npmrc` sets `ignore-scripts=true`, which makes npm skip pre/post hooks.
- **Port already in use.** NULLLAB's control plane listens on `4000` by
  default (`API_PORT` in `.env`); lab instances use `5100`–`5999` when
  running with Node directly (`LAB_PORT_RANGE_START`/`_END`). Under Docker
  Compose the range is `5100`–`5199` — if you widen it, widen the `ports:`
  mapping in `docker-compose.yml` to match, or those labs won't be reachable.
- **A lab "launched" but its URL doesn't open (Docker Compose).** The lab
  port range must be published by Compose (it is, in the shipped file). Run
  `npm run smoke`; if "target URL reachable" fails, check
  `docker compose ps` shows `127.0.0.1:5100-5199->5100-5199/tcp`.
- **"Cross-origin request blocked" (HTTP 403) from the API.** State-changing
  `/api` calls made by a *browser page* must come from the NULLLAB UI's own
  origin (`WEB_ORIGIN`, or the control plane's address on `localhost`/
  `127.0.0.1`). Pages served by lab targets are deliberately refused. `curl`,
  Burp Repeater and scripts send no `Origin` header and are unaffected.
- **Docker build is slow / fails downloading Chromium.** The image
  installs a headless Chromium for the XSS labs' verifier. If your
  network blocks Playwright's CDN, build will fail at that step — see
  `Dockerfile`'s runtime stage.
- **WSL2 / Kali / Linux.** Works like any other Linux Docker host. If you
  run NULLLAB directly with Node (no Docker), make sure you have a recent
  Node 20+ and ran `npx playwright install chromium` after `npm install`.
- **macOS.** Docker Desktop, or Node 20+ directly — both work the same
  as any other platform.
- **Running tests without starting every lab.** `npm run test:unit` runs
  only the fast, no-process-spawning tests; `npm run test:integration`
  spawns real lab processes per test file but cleans them up afterward.
- **"Browser not found" from the XSS labs' verifier when running without
  Docker.** Run `npx playwright install chromium`, or see the
  `NULLLAB_CHROMIUM_EXECUTABLE` override in `.env.example` if you already
  have a compatible Chromium installed somewhere else.
- **`npm install` tries to compile something and fails.** This
  shouldn't happen — the repo's `.npmrc` tells npm to skip lifecycle
  scripts, since `better-sqlite3`'s bundled prebuilt binary doesn't need
  compiling. If you've deleted or overridden `.npmrc`, restore it or run
  `npm install --ignore-scripts`.

## Learn more

- [`docs/architecture.md`](./docs/architecture.md) — how the control
  plane, lab runtime, and verifier actually fit together, including
  exactly how a solve gets proven server-side (and how the XSS admin bot
  works).
- [`docs/docker-mode.md`](./docs/docker-mode.md) — the advanced,
  container-per-lab-instance isolation mode.
- [`docs/coverage-matrix.md`](./docs/coverage-matrix.md) — generated;
  what's implemented, tested, and verified right now.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to add a new lab.
- [`SECURITY.md`](./SECURITY.md) — isolation model and how to report a
  real security issue in NULLLAB itself.

## License

MIT — see [`LICENSE`](./LICENSE).
