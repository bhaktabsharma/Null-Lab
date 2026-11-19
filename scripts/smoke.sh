#!/usr/bin/env bash
# End-to-end smoke test against a RUNNING NULLLAB control plane (any runtime
# mode, any deployment: `npm run dev`, `docker compose up`, ...).
#
#   bash scripts/smoke.sh [control-plane-url]      # default http://127.0.0.1:4000
#
# It drives the same HTTP the browser and Burp would: log in, launch a lab,
# confirm the URL shown to the learner is actually reachable from THIS
# machine, perform a normal request and the real IDOR exploit, confirm the
# server-side verifier recorded the solve exactly once, confirm a lab-origin
# page cannot control the control plane (CSRF guard), then stop the lab and
# confirm it is really gone. Exit status is non-zero if anything fails.
set -uo pipefail

BASE="${1:-http://127.0.0.1:4000}"
LAB="idor-invoice-leak"
pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1${2:+  ($2)}"; fail=$((fail + 1)); }
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@"; }

cpjar="$(mktemp)"; labjar="$(mktemp)"
trap 'rm -f "$cpjar" "$labjar"' EXIT

echo "NULLLAB smoke test against $BASE"

[ "$(code "$BASE/healthz")" = "200" ] && ok "control plane /healthz" || { bad "control plane /healthz" "is it running at $BASE?"; echo "result: $pass passed, $fail failed"; exit 1; }

[ "$(code -c "$cpjar" -X POST "$BASE/api/auth/guest")" = "200" ] && ok "guest login" || bad "guest login"

launch="$(curl -s --max-time 60 -b "$cpjar" -X POST "$BASE/api/labs/$LAB/instances")"
id="$(echo "$launch" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"
url="$(echo "$launch" | grep -o '"baseUrl":"[^"]*"' | head -1 | cut -d'"' -f4)"
if [ -n "$id" ] && [ -n "$url" ]; then ok "launch $LAB -> $url"; else bad "launch $LAB" "$launch"; echo "result: $pass passed, $fail failed"; exit 1; fi

[ "$(code "$url/healthz")" = "200" ] && ok "target URL reachable from this machine (the URL the UI shows)" || bad "target URL reachable from this machine" "$url"

[ "$(code -c "$labjar" -X POST -d 'username=alice&password=practice123' "$url/login")" = "302" ] && ok "log in to the target as alice" || bad "log in to the target as alice"
[ "$(code -b "$labjar" "$url/invoices/1001")" = "200" ] && ok "normal request: alice reads her own invoice" || bad "normal request: alice reads her own invoice"

solved_before="$(curl -s -b "$cpjar" "$BASE/api/instances/$id" | grep -o '"solved":[a-z]*' | head -1)"
[ "$solved_before" = '"solved":false' ] && ok "not solved by legitimate use" || bad "not solved by legitimate use" "$solved_before"

body="$(curl -s -b "$labjar" "$url/invoices/1002")"
echo "$body" | grep -q "bob" && ok "exploit: alice's session reads bob's invoice" || bad "exploit: alice's session reads bob's invoice"

solved_after="$(curl -s -b "$cpjar" "$BASE/api/instances/$id" | grep -o '"solved":[a-z]*' | head -1)"
[ "$solved_after" = '"solved":true' ] && ok "server-side verifier recorded the solve" || bad "server-side verifier recorded the solve" "$solved_after"

xp1="$(curl -s -b "$cpjar" "$BASE/api/progress" | grep -o '"xp":[0-9]*' | head -1)"
curl -s -o /dev/null -b "$labjar" "$url/invoices/1002"
xp2="$(curl -s -b "$cpjar" "$BASE/api/progress" | grep -o '"xp":[0-9]*' | head -1)"
[ -n "$xp1" ] && [ "$xp1" = "$xp2" ] && ok "replaying the exploit does not award XP twice ($xp1)" || bad "replaying the exploit does not award XP twice" "$xp1 vs $xp2"

[ "$(code -b "$cpjar" -X POST -H 'Origin: http://127.0.0.1:5100' "$BASE/api/instances/$id/stop")" = "403" ] && ok "a lab-origin page cannot stop instances (CSRF guard)" || bad "CSRF guard rejects a lab-origin request"

[ "$(code -b "$cpjar" -X POST "$BASE/api/instances/$id/stop")" = "200" ] && ok "stop instance" || bad "stop instance"
sleep 1
[ "$(code "$url/healthz")" = "200" ] && bad "target is gone after stop" "still answering at $url" || ok "target is gone after stop"

echo "result: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
