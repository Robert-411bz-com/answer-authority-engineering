#!/usr/bin/env bash
# Regression fixtures for guardrail checks 1 and 3.
# Each fixture is removed before the script exits.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$ROOT/scripts/ci-guardrails.sh"
LOG="$(mktemp)"
PROBES=()

cleanup() {
  rm -f "$LOG"
  if [ "${#PROBES[@]}" -gt 0 ]; then
    rm -f "${PROBES[@]}"
  fi
}
trap cleanup EXIT

track() {
  PROBES+=("$1")
  printf '%s\n' "$2" >"$1"
}

drop() {
  rm -f "$1"
  local kept=()
  local probe
  for probe in "${PROBES[@]+"${PROBES[@]}"}"; do
    [ "$probe" = "$1" ] && continue
    kept+=("$probe")
  done
  PROBES=("${kept[@]+"${kept[@]}"}")
}

expect_clean() {
  local label="$1"
  if bash "$GUARD" >"$LOG" 2>&1; then
    echo "ok  $label"
  else
    echo "not ok  $label"
    cat "$LOG"
    exit 1
  fi
}

expect_violation() {
  local label="$1"
  local needle="$2"
  set +e
  bash "$GUARD" >"$LOG" 2>&1
  local code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    echo "not ok  $label (guardrails exited 0)"
    cat "$LOG"
    exit 1
  fi
  if ! grep -F "$needle" "$LOG" >/dev/null; then
    echo "not ok  $label (output missing $needle)"
    cat "$LOG"
    exit 1
  fi
  echo "ok  $label (exit $code)"
}

expect_clean "clean repository, including workers_dev = true and governance text"

# Assemble the host token here so this script is not itself a violation.
ZONE="$(printf '%s.%s' workers dev)"

GOV="$ROOT/guardrail-probe-governance.md"
track "$GOV" "$(printf '%s\n' "No \`${ZONE}\` URLs in source code." "Service bindings replace all hardcoded \`${ZONE}\` URLs.")"
expect_clean "approved explanatory governance text"
drop "$GOV"

BARE="$ROOT/guardrail-probe-bare.md"
track "$BARE" "https://411bz-hidden.bob-0a9.${ZONE}"
expect_violation "bare prohibited Worker URL" "guardrail-probe-bare.md"
drop "$BARE"

SAME="$ROOT/guardrail-probe-same-line.md"
track "$SAME" "https://411bz-hidden.bob-0a9.${ZONE} No \`${ZONE}\`"
expect_violation "prohibited URL on an exempt governance line" "guardrail-probe-same-line.md"
drop "$SAME"

DEPLOY="$ROOT/scripts/guardrail-probe-deploy.sh"
track "$DEPLOY" "curl -sf https://411bz-stripe.bob-0a9.${ZONE}/health"
expect_violation "prohibited URL in a deployment script" "scripts/guardrail-probe-deploy.sh"
drop "$DEPLOY"

IMPORT="$ROOT/workers/411bz-authority-engine/src/guardrail-probe-import.ts"
track "$IMPORT" "import { POLICY_DEFAULTS } from 'shared-authority-core';"
expect_clean "legitimate shared policy import"
drop "$IMPORT"

READ="$ROOT/workers/411bz-frontend/src/guardrail-probe-display.ts"
track "$READ" "import { POLICY_DEFAULTS } from 'shared-authority-core';
export const stages = POLICY_DEFAULTS.ORCHESTRATOR_STAGE_COUNT;"
expect_clean "approved display-only policy read"
drop "$READ"

INLINE="$ROOT/workers/411bz-authority-engine/src/guardrail-probe-inline.ts"
track "$INLINE" "const EXAMINER_CATEGORY_COUNT = 600;"
expect_violation "unauthorized inline policy constant" "guardrail-probe-inline.ts"
drop "$INLINE"

DOTTED="$ROOT/workers/411bz-authority-engine/src/guardrail-probe-dotted.ts"
track "$DOTTED" "POLICY_DEFAULTS.EXAMINER_CATEGORY_COUNT = 1;"
expect_violation "dotted policy assignment" "guardrail-probe-dotted.ts"
drop "$DOTTED"

DUP="$ROOT/workers/411bz-orchestrator/src/guardrail-probe-duplicate.ts"
track "$DUP" "export const POLICY_DEFAULTS = { MAX_OVERLAYS: 5 };"
expect_violation "duplicate policy definition" "guardrail-probe-duplicate.ts"
drop "$DUP"

NUMBER="$ROOT/workers/411bz-frontend/src/guardrail-probe-number.ts"
track "$NUMBER" "const PAGE_SIZE = 25;"
expect_clean "unrelated numeric constant"
drop "$NUMBER"

echo "All guardrail regression tests passed."
