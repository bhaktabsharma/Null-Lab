#!/usr/bin/env bash
# Verifies NULLLAB's EXPERIMENTAL docker runtime on a machine with a real Docker
# daemon. This is the check the author could NOT run (no daemon in the build
# environment), so please run it and read the result:
#
#   npm run docker:selftest            # or: bash scripts/docker-selftest.sh
#
# It builds the images, starts the control plane in docker mode, runs the HTTP
# smoke test (launch -> reach target -> real exploit -> verifier callback ->
# stop), inspects a live lab container's isolation settings, proves the lab
# has no outbound network, then SIGKILLs the control plane and checks that the
# next boot removes the orphaned container. Nothing is changed outside Docker
# (it copies .env.example to .env only if .env is missing).
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1${2:+  ($2)}"; fail=$((fail + 1)); }
say() { echo; echo "== $1"; }

command -v docker >/dev/null 2>&1 || { echo "docker not found on PATH"; exit 2; }
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || { echo "Docker daemon not reachable (is Docker Desktop / dockerd running?)"; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 plugin not found"; exit 2; }
[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example"; }

export DOCKER_GID="$(stat -Lc %g /var/run/docker.sock 2>/dev/null || echo 0)"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.docker-mode.yml)
BASE="http://127.0.0.1:4000"
jar="$(mktemp)"; trap 'rm -f "$jar"' EXIT

wait_healthy() {
  for _ in $(seq 1 90); do
    curl -s -o /dev/null --max-time 2 "$BASE/healthz" && return 0
    sleep 1
  done
  return 1
}
launch_lab() {
  curl -s -c "$jar" -o /dev/null -X POST "$BASE/api/auth/guest"
  curl -s --max-time 90 -b "$jar" -X POST "$BASE/api/labs/idor-invoice-leak/instances"
}
managed() { docker ps -aq --filter label=nulllab.managed=true --filter label=nulllab.instance; }

say "1/6 build images (first run downloads base images; can take several minutes)"
if "${COMPOSE[@]}" --profile docker-mode build; then ok "images built (control plane + shared lab image)"; else bad "image build"; echo "result: $pass passed, $fail failed"; exit 1; fi

say "2/6 start the control plane in docker mode"
"${COMPOSE[@]}" up -d nulllab >/dev/null 2>&1
if wait_healthy; then ok "control plane healthy"; else bad "control plane healthy"; "${COMPOSE[@]}" logs --tail 60 nulllab; echo "result: $pass passed, $fail failed"; exit 1; fi
curl -s "$BASE/api/meta" | grep -q '"runtimeMode":"docker"' && ok "running in docker mode" || bad "running in docker mode" "$(curl -s "$BASE/api/meta")"

say "3/6 end-to-end HTTP smoke test through the container runtime"
if bash scripts/smoke.sh "$BASE"; then ok "smoke test (target reachable via published port, exploit verified through the internal callback, stop cleans up)"; else bad "smoke test"; fi

say "4/6 isolation of a live lab container"
launch="$(launch_lab)"
iid="$(echo "$launch" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"
cid="$(docker ps -q --filter "label=nulllab.instance=$iid")"
if [ -z "$cid" ]; then
  bad "found the lab container" "launch response: $launch"
else
  ok "found the lab container ($cid)"
  insp() { docker inspect -f "$1" "$cid"; }
  [ "$(insp '{{.HostConfig.ReadonlyRootfs}}')" = "true" ]  && ok "read-only root filesystem"        || bad "read-only root filesystem"
  [ "$(insp '{{.HostConfig.Privileged}}')" = "false" ]     && ok "not privileged"                    || bad "not privileged"
  insp '{{.HostConfig.CapDrop}}' | grep -qi all            && ok "all capabilities dropped"          || bad "all capabilities dropped"
  [ "$(insp '{{.HostConfig.Memory}}')" -gt 0 ] 2>/dev/null && ok "memory limit set"                  || bad "memory limit set"
  [ "$(insp '{{.HostConfig.PidsLimit}}')" -gt 0 ] 2>/dev/null && ok "pids limit set"                 || bad "pids limit set"
  [ "$(insp '{{len .HostConfig.PortBindings}}')" = "0" ]   && ok "no ports published by the lab container itself" || bad "no ports published by the lab container itself"
  insp '{{range .Mounts}}{{.Type}} {{end}}' | grep -Eq 'bind|volume' && bad "no bind/volume mounts (esp. no docker.sock)" || ok "no bind/volume mounts (esp. no docker.sock)"
  [ "$(docker network inspect nulllab_labnet -f '{{.Internal}}')" = "true" ] && ok "lab network is internal (no route out)" || bad "lab network is internal (no route out)"
  [ "$(docker exec "$cid" id -u 2>/dev/null)" != "0" ]     && ok "lab process is not root"           || bad "lab process is not root"
  docker exec "$cid" ls /var/run/docker.sock >/dev/null 2>&1 && bad "docker.sock not visible inside lab" || ok "docker.sock not visible inside lab"
  if docker exec "$cid" node -e "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:3000});s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))" >/dev/null 2>&1; then
    bad "lab has NO outbound internet access" "it reached 1.1.1.1:443"
  else
    ok "lab has NO outbound internet access"
  fi
  docker exec "$cid" node -e "fetch('http://nulllab-control:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && ok "lab can reach the control plane by alias (verifier callback path)" || bad "lab can reach the control plane by alias"
fi

say "5/6 crash recovery: SIGKILL the control plane with a lab running, then boot again"
before="$(managed | wc -l | tr -d ' ')"
[ "$before" -ge 1 ] && ok "a lab container is running before the crash ($before)" || bad "a lab container is running before the crash"
docker kill nulllab >/dev/null 2>&1
"${COMPOSE[@]}" up -d nulllab >/dev/null 2>&1
wait_healthy || bad "control plane healthy after crash recovery"
sleep 2
after="$(managed | wc -l | tr -d ' ')"
[ "$after" = "0" ] && ok "orphaned lab container was removed on the next boot" || bad "orphaned lab container was removed on the next boot" "still $after"

say "6/6 teardown"
"${COMPOSE[@]}" down >/dev/null 2>&1 && ok "compose down"
docker network rm nulllab_labnet >/dev/null 2>&1
echo
echo "result: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && echo "Docker runtime verified on this machine." || { echo "Please send the FAIL lines above (and: docker compose logs nulllab) so they can be fixed."; }
[ "$fail" -eq 0 ]
