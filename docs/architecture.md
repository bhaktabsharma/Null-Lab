# Architecture

## The three parts

**Control plane** (`apps/api` + `apps/web`). Owns accounts, the lab
catalogue, instance lifecycle, progress/XP, and theme preferences. It
never runs vulnerable code itself.

**Lab runtime plane** (`labs/<family>/<lab-id>/server.ts`). Each lab is
its own small Fastify app — a believable target (a store, a help desk, a
search portal) with one real, intentionally vulnerable code path. Every
running *instance* of a lab is a separate OS process (or separate Docker
container — see `docs/docker-mode.md`), with its own port and its own
data.

**Verifier/orchestrator**. Conceptually distinct, implemented as a
library the control plane calls directly for Milestone 1
(`runtime/orchestrator`), rather than a second standalone network
service — a deliberate simplification documented here rather than hidden.
It can be split into its own process later without changing the contract
below, since lab targets only ever talk to `NULLLAB_ORCHESTRATOR_URL`.

## How a solve actually gets verified

1. The control plane generates a random 256-bit `instanceToken` for each
   launched instance and passes it to that lab's process only, via env
   vars (`NULLLAB_INSTANCE_*` — see `packages/lab-sdk/src/context.ts`).
   The browser/frontend never sees it.
2. Inside the lab's real route handler, at the exact point the code has
   honestly determined the security invariant was broken (e.g. "the
   invoice returned belongs to a different user than the session"), the
   handler calls `reportSolve(ctx, evidence)`.
3. `reportSolve` POSTs to the control plane's
   `/internal/instances/:id/solve`, authenticated with the instance
   token. The control plane re-validates the token against what it
   actually generated for that instance, and if it matches, records the
   solve (idempotently — replays don't re-award XP) and updates XP.

No step in this chain trusts anything the client claims. A reflected
string, a client-side "I did it" flag, or a modified frontend request
can't produce a solve — only the lab's own server-side code, actually
executing the vulnerable logic, can.

### XSS labs: the admin bot

Reflected/stored XSS can't be verified by matching a string in a
response — that proves reflection, not script execution. Instead:

1. Each XSS-style lab exposes `POST /__internal/admin-session`, which
   mints a session cookie for a simulated "admin" — but only to a caller
   that already holds the instance token (the control plane, server to
   server; the browser never sees the token).
2. The control plane's admin bot (`apps/api/src/instances/admin-bot.ts`,
   using `playwright-core`) takes that cookie, loads it into a real
   headless-Chromium browser context, and navigates to whatever path the
   person being tested supplies (a crafted query string for reflected
   XSS, or a page where they've already stored a payload).
3. If the payload actually executes, it's the page's own injected script
   that calls the lab's `/collect` endpoint with a per-instance secret
   only visible to an authenticated-admin render of the page — and *that*
   call is what triggers `reportSolve`, via the exact same contract as
   every other lab.

The admin bot only drives the browser; it never inspects the page or
decides "solved" itself.

## Why SQLite and real processes instead of a bigger stack

Per the project's own ground rules (avoid infrastructure without a
demonstrated need; the repo should be runnable by one developer on an
ordinary laptop): SQLite is the default database everywhere (control
plane and, for the SQL injection labs specifically, a real per-instance
database each lab genuinely queries), and `RUNTIME_MODE=process` gives
real OS-process isolation without requiring Docker at all. `RUNTIME_MODE=docker`
exists for stronger isolation once you have Docker available — see
`docs/docker-mode.md`.

## Extending the catalogue

Nothing about a lab is hardcoded into the frontend or the API — the
catalogue is entirely data-driven from `labs/**/manifest.json`
(`apps/api/src/labs/catalog.ts` walks the directory at boot and validates
every manifest against the Zod schema in `packages/shared/src/manifest.ts`,
throwing on an invalid one rather than silently skipping it). Adding a
lab never requires touching the control plane or frontend code — see
`CONTRIBUTING.md`.


## Networking and trust boundaries

Who talks to whom, and what each hop is allowed to do:

```
browser / Burp / curl ──► 127.0.0.1:4000   control plane (UI, /api, /internal)
                     └──► 127.0.0.1:51xx   one lab target per launched instance
lab target ──► control plane /internal/instances/<id>/solve   (per-instance token)
admin bot (Chromium, inside the control plane) ──► lab target on loopback
```

- **Process mode, on your machine.** Control plane and labs bind `127.0.0.1`.
  The URL the UI shows is exactly what you open or proxy.
- **Process mode, inside the Compose container.** A service listening on the
  container's own loopback cannot be reached through a published port, so labs
  bind `0.0.0.0` (`LAB_BIND_HOST`) *inside* the container and Compose publishes
  `127.0.0.1:5100-5199` to the host. Exposure is limited by that mapping.
- **Docker mode (experimental).** Lab containers sit on an `--internal`
  network: no route out, and Docker can't publish ports from such a network.
  The control plane is attached to that network, so (a) labs reach it by the
  alias `nulllab-control` to report solves and (b) a small TCP forwarder in the
  control plane listens on each lab's public port and pipes bytes to the lab
  container. The forwarder never parses or alters HTTP, so a proxy sees the
  lab's real responses. Docker mode is only supported when the control plane
  itself runs in a container (`NULLLAB_SELF_CONTAINER`).
- **`/internal` routes** accept only a per-instance secret token held by that
  one lab process. They are not CSRF-guarded because browsers don't call them.
- **`/api` routes** are cookie-authenticated and CSRF-guarded by Origin (see
  `SECURITY.md`).

### Lifecycle guarantees

- A lab that dies, or fails its health check, is reported as an error with the
  reason it gave (last output / exit code), and its port and data are released.
- `stop` kills the lab's whole process group, deletes its data file, and frees
  its port. `reset` does that and starts a fresh instance with a new token; the
  learner's XP and solve history are kept.
- If the control plane crashes or is SIGKILLed, the labs it started keep
  running. On the next boot they are found by an argv marker
  (`--nulllab-instance=<id>`) and killed; only instances recorded in *this*
  control plane's database are touched.
