# Experimental: one Docker container per lab

> **Status: EXPERIMENTAL and not yet verified against a real Docker daemon.**
> The command construction is covered by unit tests against a stub `docker`
> CLI, and the TCP forwarder is tested with real sockets. The part that needs a
> daemon — images build, containers start, the network really has no egress —
> is checked by `npm run docker:selftest`, which you run on a Docker machine.
> Until that has passed for you, treat this mode as unproven.

By default (`RUNTIME_MODE=process`) every lab target is an isolated **OS
process**. That is *logical* isolation (own port, own data, minimal
environment), not a sandbox. `RUNTIME_MODE=docker` runs every lab instance in
its own container instead:

| Property | How |
|---|---|
| Non-root, read-only root FS | image `USER nulllab`; `--read-only`, tmpfs `/tmp` |
| No privileges | `--cap-drop ALL`, `--security-opt no-new-privileges`, never `--privileged` |
| Resource limits | `--memory` (= `--memory-swap`), `--cpus`, `--pids-limit`, `nofile` ulimit, from each lab manifest |
| No host access | no bind mounts, no Docker socket in lab containers |
| No outbound network | network created with `--internal` |
| Lifetime | control plane's idle/max-lifetime sweep removes the container |

## Topology

```
browser/Burp ► 127.0.0.1:<port> ─(Compose publishes 5100-5199 to host loopback)─►
   control-plane container: TcpForwarder on 0.0.0.0:<port>
      ─(internal Docker network, no route out)─► lab container  nulllab-lab-<id>:<port>
lab container ─► http://nulllab-control:<API_PORT>/internal/...   (verifier callback)
```

The control plane container is attached to the internal network under the
alias `nulllab-control`. All labs share **one image** (`nulllab-lab:local`);
the orchestrator picks the lab with `NULLLAB_LAB_ENTRY` at `docker run` time,
so launching never runs `docker build`.

## Supported setup: control plane under Docker Compose

Docker mode is **only supported when the control plane itself runs in a
container** (`NULLLAB_SELF_CONTAINER`, set to `nulllab` by the shipped Compose
file). Running the control plane directly on the host (`npm run dev`) with
`RUNTIME_MODE=docker` is not supported: on Docker Desktop (Windows/macOS) host
processes can't reach containers on an internal network. The control plane
refuses to start in that configuration, with an explanatory error.

## Trust boundary — read before enabling

The control plane needs the host Docker socket to create lab containers.
`docker-compose.docker-mode.yml` mounts `/var/run/docker.sock` into the
**control plane** container (never into labs). Anything that can use that
socket controls every container on the host. Only enable this on a machine
where you accept that. A restrictive socket proxy (for example one that only
allows `containers`, `networks` and `images` read/create/delete) would reduce
the risk but is not provided here.

## Enable and verify

```bash
npm run docker:selftest
```

That builds both images, starts the control plane in docker mode, runs
`scripts/smoke.sh` through the container runtime, inspects a live lab
container's isolation settings, proves it has no outbound network, SIGKILLs the
control plane and checks that the next boot removes the orphaned container, then
tears down. It prints PASS/FAIL per check; please report any FAIL lines.

Manual equivalent:

```bash
export DOCKER_GID=$(stat -Lc %g /var/run/docker.sock)   # 0 is fine on Docker Desktop
docker compose -f docker-compose.yml -f docker-compose.docker-mode.yml --profile docker-mode build
docker compose -f docker-compose.yml -f docker-compose.docker-mode.yml up -d
npm run smoke
```

## Cleanup and reset

`docker ps` shows one `nulllab-lab-<id>` container per running instance, all
labelled `nulllab.managed=true`. Stop/reset in the UI removes them. After a
control-plane crash, the next boot removes every container labelled with this
control plane's name. Emergency manual cleanup:

```bash
docker rm -f $(docker ps -aq --filter label=nulllab.managed=true)
docker network rm nulllab_labnet
```

## Known limitations

- The control plane's `/api` port is reachable from lab containers over the
  internal network (a lab could call it as an anonymous client). `/internal`
  routes still require the per-instance token and `/api` requires login. A
  separate internal-only listener is planned.
- `docker:27-cli` is pulled as the CLI source; pin it if you need a fixed version.
- Windows native Node (outside WSL2/Docker) has no orphan reaping for process mode.
