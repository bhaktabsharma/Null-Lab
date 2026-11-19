# Security Policy

NULLLAB intentionally hosts vulnerable web applications for practice.
That's the entire point — but it means the security boundary between
"the vulnerable targets" and "everything else" is the one thing this
project cannot get wrong.

## Please don't deploy this publicly

**Never expose NULLLAB, or any lab target it launches, to the public
internet.** Everything here defaults to binding `127.0.0.1` (loopback)
only, specifically so a laptop running NULLLAB isn't reachable from the
local network, let alone the internet. If you change that binding, you
are choosing to expose intentionally-broken authentication, authorization,
and injection-vulnerable code to whoever can reach it. Don't put NULLLAB
behind a reverse proxy on a public hostname, don't port-forward it on
your router, and don't run it on a shared/cloud host without equivalent
isolation to a locked-down local machine.

## What's actually isolated, and how

- **Control plane vs. lab targets.** The control-plane API (`apps/api`)
  owns accounts, progress, and lab lifecycle. It never executes
  vulnerable code itself — lab targets (`labs/*/*/server.ts`) are
  separate processes (or separate Docker containers in
  `RUNTIME_MODE=docker`, see `docs/docker-mode.md`), each started with
  only a narrow, per-instance token — never the control plane's session
  secret, database, or any other instance's data.
- **The verifier contract.** A lab reports a solve only from inside its
  own real, vulnerable request handler, using a per-instance secret token
  the control plane generated and that only that lab process holds (see
  `packages/lab-sdk/src/verifier.ts` and `internal/routes.ts`). The
  browser and the frontend never see this token, and a client can't
  submit its own "I solved it" flag.
- **Per-instance isolation.** Every lab instance gets its own port and
  its own data (a SQLite file for the database-backed labs, memory for the
  rest). Instances are owned by exactly one NULLLAB account and that
  ownership is checked on every instance route.
  - **Process mode (default) is logical isolation, not a sandbox.** Labs run as
    the same OS user as the control plane, each in its own process, port and
    data store, started with a minimal environment (no control-plane secrets).
    That's fine for practising against synthetic, intentionally vulnerable apps
    on a machine you control. It is not a security boundary against a
    determined attacker already running code in a lab.
  - **Docker mode (`RUNTIME_MODE=docker`) is EXPERIMENTAL.** One container per
    lab: read-only root filesystem, all capabilities dropped, no-new-privileges,
    CPU/memory/PID limits, no host mounts, no Docker socket, and a network
    created with `--internal` (no outbound route). Its command construction is
    unit-tested against a stub CLI, but it has not been run against a real
    daemon by the author — run `npm run docker:selftest` to verify it on your
    machine. It requires the Docker socket to be mounted into the *control
    plane* container, which is a significant privilege; see `docs/docker-mode.md`.
- **Labs can't drive the control plane from the browser.** Lab pages run
  attacker-controlled JavaScript by design (the XSS labs). State-changing
  `/api` requests are refused unless their `Origin` is the NULLLAB UI or the
  control plane itself, and a browser-declared cross-site request without an
  `Origin` is refused too, so a lab page can't use your logged-in cookie to
  launch, stop or reset instances. Keep the UI on `localhost` and labs on
  `127.0.0.1` (the defaults): different hosts are different *sites*, which also
  keeps the control-plane cookie away from lab pages.
- **SSRF labs never make a real network call, in any runtime mode.** NULLLAB's `process` runtime
  (the default) has no network sandbox — a lab that actually fetched an attacker-supplied URL over
  the real network would be a vulnerability in the platform itself, not just the lab. Every SSRF
  lab is built on `packages/lab-sdk/src/mock-internal-net.ts`, a simulated network that parses URLs
  with the standard library's own `URL` class (string canonicalization only, no I/O) and resolves
  requests against a small, in-memory, lab-defined table of fake "internal services." A host that
  isn't in that table gets a fast simulated refusal; there is no code path from any SSRF lab to a
  real socket, DNS lookup, the public internet, cloud metadata, or the host machine.
- **File-handling labs never touch the real filesystem, in any runtime mode.** For the same
  reason as SSRF above, every path-traversal, LFI, upload-validation, zip-slip, and backup-file
  lab is built on `packages/lab-sdk/src/mini-vfs.ts`, a simulated filesystem backed by an in-memory
  `Map`. It uses `node:path`'s `posix` helpers as pure string math (no I/O) to get real,
  standards-accurate `../` normalization behavior, but there is no code path anywhere in these
  labs that opens a real file descriptor — a traversal payload can never reach an actual host file.
- **GraphQL and WebSocket labs use the real `graphql` and `ws`/`@fastify/websocket` packages** (pinned
  versions, at least two weeks old at the time they were added) — no simulated protocol. They
  carry no special risk beyond any other lab: each exposes only its own small, synthetic schema or
  message handler, with no filesystem or network access of its own.
- **Network exposure.** The control plane and lab ports bind to loopback by
  default (`LAB_BIND_HOST=127.0.0.1`). Under Compose, labs bind `0.0.0.0`
  *inside the container only* (otherwise published ports can't reach them) and
  Compose publishes them to the host's `127.0.0.1` only. Never change those
  mappings to `0.0.0.0`.
- **Resets are real resets.** Resetting a lab deletes its process (or
  container) and its on-disk database file, then starts a genuinely fresh
  instance — not a reused one with old state.

## Reporting a vulnerability

If you find a way to:
- make a lab report a solve without actually exploiting the real,
  described vulnerability,
- read or affect another user's account, progress, or running instance,
- escape a lab instance's isolation (reach the control plane's secrets,
  another instance's data, or the host) from inside a lab target,
- or bypass the loopback-only binding in a way that matters,

please open a private report (GitHub's "Report a vulnerability" under the
Security tab, if available on this repository) rather than a public
issue, so there's time to fix it before it's public. Otherwise, regular
GitHub issues are fine for anything else — including "this lab's intended
vulnerability is actually unexploitable" or "this lab's verifier has a
false positive," which are bugs in the product, not security reports
about NULLLAB itself.

## Scope notes

- Bugs *inside* a lab target that are the lab's whole point (e.g. "the
  invoice-leak lab leaks invoices") are not security reports — that's the
  lab working as designed.
- `RUNTIME_MODE=docker` has not been exercised by this project's own
  automated test suite (see `docs/docker-mode.md` for why) — review
  `runtime/orchestrator/src/docker-runtime.ts` yourself before relying on
  it, and treat issues found there as regular, if higher-priority, bugs.
