#!/usr/bin/env bash
# Tests for the production-overwrite guard. Never executes a deploy script:
# the guard function is exercised on its own, and the deploy scripts are only
# parsed (bash -n) and read.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/scripts/lib/production-guard.sh"
PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# Run the guard alone in a clean subshell. $1 = env value ("__unset__" to unset); rest = workers.
run_guard() {
  local value="$1"; shift
  local cmd="source '$LIB'; require_production_overwrite_ack test-script $*; echo __PASSED_GUARD__"
  if [[ "$value" == "__unset__" ]]; then
    env -u I_UNDERSTAND_THIS_OVERWRITES_PRODUCTION bash -c "$cmd" >"$OUT" 2>"$ERR"
  else
    I_UNDERSTAND_THIS_OVERWRITES_PRODUCTION="$value" bash -c "$cmd" >"$OUT" 2>"$ERR"
  fi
}

OUT="$(mktemp)"; ERR="$(mktemp)"
trap 'rm -f "$OUT" "$ERR"' EXIT

echo "=== guard function ==="
run_guard __unset__ 411bz-boss-ai 411bz-frontend 411bz-orchestrator; rc=$?
check "unset: exits 1" '[[ $rc -eq 1 ]]'
check "unset: does not continue" '! grep -q __PASSED_GUARD__ "$OUT"'
check "unset: prints 411bz-boss-ai flagged as shared" 'grep -q "411bz-boss-ai.*same name as a 411bz-ai worker" "$OUT"'
check "unset: prints 411bz-frontend flagged as shared" 'grep -q "411bz-frontend.*same name as a 411bz-ai worker" "$OUT"'
check "unset: prints non-shared worker unflagged" 'grep -qx "  - 411bz-orchestrator" "$OUT"'
check "unset: says nothing was deployed" 'grep -q "Nothing was deployed" "$ERR"'

for v in "" "YES" "Yes" "y" "true" "1" "yes " " yes" "yess"; do
  run_guard "$v" 411bz-boss-ai; rc=$?
  check "value '$v': refused" '[[ $rc -eq 1 ]] && ! grep -q __PASSED_GUARD__ "$OUT"'
done

run_guard "yes" 411bz-boss-ai; rc=$?
check "value 'yes': continues" '[[ $rc -eq 0 ]] && grep -q __PASSED_GUARD__ "$OUT"'
check "value 'yes': still prints the workers" 'grep -q "411bz-boss-ai" "$OUT"'

# Lines that deploy, mutate, or install: none may run before the guard.
RISKY='wrangler|npx |git pull|npm install|ci-guardrails|cd workers|cd \.\./|cd "\$ROOT/workers'

guard_first() {
  local f="$1" guard_line risky_line
  guard_line=$(grep -n 'require_production_overwrite_ack' "$f" | head -1 | cut -d: -f1)
  risky_line=$(grep -nE "$RISKY" "$f" | grep -vE '^[0-9]+:\s*#' | head -1 | cut -d: -f1)
  [[ -n "$guard_line" && -n "$risky_line" && "$guard_line" -lt "$risky_line" ]]
}

echo "=== scripts/deploy-all.sh (parsed, not run) ==="
F="$ROOT/scripts/deploy-all.sh"
check "bash -n syntax" 'bash -n "$F"'
check "guard runs before any deploy/mutating command" 'guard_first "$F"'
check "guard receives the same list the loop deploys" \
  'grep -q "require_production_overwrite_ack .*\"\${DEPLOY_ORDER\[@\]}\"" "$F" && grep -q "for worker in \"\${DEPLOY_ORDER\[@\]}\"" "$F"'
mapfile -t ALL_WORKERS < <(sed -n '/^DEPLOY_ORDER=(/,/^)/p' "$F" | grep -oE '"[^"]+"' | tr -d '"')
run_guard __unset__ "${ALL_WORKERS[@]}"; rc=$?
check "default path exits with its real list" '[[ $rc -eq 1 ]]'
check "its list includes 411bz-boss-ai" 'grep -q "  - 411bz-boss-ai" "$OUT"'
check "its list includes 411bz-frontend" 'grep -q "  - 411bz-frontend" "$OUT"'

echo "=== scripts/deploy-v4.sh (parsed, not run) ==="
F="$ROOT/scripts/deploy-v4.sh"
check "bash -n syntax" 'bash -n "$F"'
check "guard runs before any deploy/mutating command (incl. git pull)" 'guard_first "$F"'
V4_LIST=$(grep -E '^DEPLOY_WORKERS=\(' "$F")
for w in $(grep -oE 'cd (workers/|\.\./)[a-z0-9-]+' "$F" | sed -E 's#cd (workers/|\.\./)##'); do
  check "deployed worker '$w' is in the printed list" '[[ "$V4_LIST" == *"\"$w\""* ]]'
done
mapfile -t V4_WORKERS < <(echo "$V4_LIST" | grep -oE '"[^"]+"' | tr -d '"')
run_guard __unset__ "${V4_WORKERS[@]}"; rc=$?
check "default path exits with its real list" '[[ $rc -eq 1 ]]'
check "its list includes 411bz-frontend" 'grep -q "  - 411bz-frontend" "$OUT"'

echo ""
echo "deploy guard tests: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
