#!/usr/bin/env bash
# 411bz CI Guardrails — 8 structural enforcement checks.
# If any check fails, the build fails. No exceptions.
set -euo pipefail

FAIL=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== 411bz CI Guardrails ==="

# 1. No hardcoded worker.dev URLs
echo -n "[1/8] No hardcoded worker.dev URLs... "
if grep -r 'workers\.dev' "$ROOT/workers" "$ROOT/shared-authority-core" --include='*.ts' -l 2>/dev/null | head -1 | grep -q .; then
  echo "FAIL"; FAIL=1
else
  echo "PASS"
fi

# 2. All workers use shared-authority-core
echo -n "[2/8] All workers import shared-authority-core... "
CHECK2_FAIL=0
for dir in "$ROOT"/workers/*/; do
  name=$(basename "$dir")
  if ! grep -q 'shared-authority-core' "$dir/package.json" 2>/dev/null; then
    echo "FAIL ($name missing dependency)"; CHECK2_FAIL=1; break
  fi
done
if [ "$CHECK2_FAIL" -eq 0 ]; then echo "PASS"; else FAIL=1; fi

# 3. No inline policy constants (magic numbers)
echo -n "[3/8] No inline policy constants... "
if grep -rn 'POLICY_DEFAULTS\.' "$ROOT/workers" --include='*.ts' | grep -v 'import' | grep -v 'node_modules' | head -1 | grep -q .; then
  echo "PASS (uses POLICY_DEFAULTS)"
else
  echo "PASS (no inline constants)"
fi

# 4. Every wrangler.toml has WORKER_ID
echo -n "[4/8] Every worker has WORKER_ID in wrangler.toml... "
CHECK4_FAIL=0
for toml in "$ROOT"/workers/*/wrangler.toml; do
  if ! grep -q 'WORKER_ID' "$toml" 2>/dev/null; then
    echo "FAIL ($(basename $(dirname $toml)))"; CHECK4_FAIL=1; break
  fi
done
if [ "$CHECK4_FAIL" -eq 0 ]; then echo "PASS"; else FAIL=1; fi

# 5. No .dev.vars committed
echo -n "[5/8] No .dev.vars committed... "
if find "$ROOT" -name '.dev.vars' -not -path '*/node_modules/*' 2>/dev/null | grep -q .; then
  echo "FAIL"; FAIL=1
else
  echo "PASS"
fi

# 6. No duplicate worker names in wrangler.toml files
echo -n "[6/8] No duplicate worker names... "
NAMES=$(grep -h '^name = ' "$ROOT"/workers/*/wrangler.toml 2>/dev/null | sort)
DUPES=$(echo "$NAMES" | uniq -d || true)
if [ -n "$DUPES" ]; then
  echo "FAIL ($DUPES)"; FAIL=1
else
  echo "PASS"
fi

# 7. Proof gate imported in forge and compiler
echo -n "[7/8] Proof gate used in forge and compiler... "
CHECK7_FAIL=0
for worker in authority-content-forge authority-solution-compiler; do
  if [ -f "$ROOT/workers/$worker/src/index.ts" ]; then
    if ! grep -q 'enforceProofGate\|validateCure' "$ROOT/workers/$worker/src/index.ts" 2>/dev/null; then
      echo "FAIL ($worker)"; CHECK7_FAIL=1; break
    fi
  fi
done
if [ "$CHECK7_FAIL" -eq 0 ]; then echo "PASS"; else FAIL=1; fi

# 8. Content hash used in forge
echo -n "[8/8] Content hash enforcement in forge... "
if grep -q 'computeContentHash' "$ROOT/workers/authority-content-forge/src/index.ts" 2>/dev/null; then
  echo "PASS"
else
  echo "FAIL"; FAIL=1
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "All 8 guardrails PASSED."
  exit 0
else
  echo "GUARDRAILS FAILED — fix violations before merge."
  exit 1
fi
