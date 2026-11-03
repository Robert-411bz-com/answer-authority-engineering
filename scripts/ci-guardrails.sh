#!/usr/bin/env bash
# 411bz CI Guardrails — 9 structural enforcement checks.
# If any check fails, the build fails. No exceptions.
set -euo pipefail

FAIL=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== 411bz CI Guardrails ==="

# 1. No hardcoded Worker hosts.
# A hostname or URL fails even when the same line also contains an approved
# explanation. Only the two bare governance phrases matched below are
# explanatory. The workers_dev platform flag does not use that host token.
echo -n "[1/9] No hardcoded worker.dev URLs... "
CHECK1_FAIL=0
CHECK1_HITS=""
CHECK1_LINES=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  CHECK1_LINES+=("$line")
done < <(grep -r 'workers\.dev' "$ROOT" --include='*.ts' --include='*.toml' --include='*.md' --include='*.sh' -n 2>/dev/null || true)
for line in "${CHECK1_LINES[@]+"${CHECK1_LINES[@]}"}"; do
  if printf '%s\n' "$line" | grep -qE '([A-Za-z0-9-]+\.)workers\.dev|https?://[^[:space:]]*workers\.dev'; then
    CHECK1_HITS="${CHECK1_HITS}${line}"$'\n'
    CHECK1_FAIL=1
    continue
  fi
  if printf '%s\n' "$line" | grep -qF 'No `workers.dev`'; then
    continue
  fi
  if printf '%s\n' "$line" | grep -qF 'hardcoded `workers.dev`'; then
    continue
  fi
  CHECK1_HITS="${CHECK1_HITS}${line}"$'\n'
  CHECK1_FAIL=1
done
if [ "$CHECK1_FAIL" -eq 0 ]; then
  echo "PASS"
else
  echo "FAIL"
  printf '%s' "$CHECK1_HITS"
  FAIL=1
fi

# 2. All workers use shared-authority-core
echo -n "[2/9] All workers import shared-authority-core... "
CHECK2_FAIL=0
for dir in "$ROOT"/workers/*/; do
  name=$(basename "$dir")
  if ! grep -q 'shared-authority-core' "$dir/package.json" 2>/dev/null; then
    echo "FAIL ($name missing dependency)"; CHECK2_FAIL=1; break
  fi
done
if [ "$CHECK2_FAIL" -eq 0 ]; then echo "PASS"; else FAIL=1; fi

# 3. No inline policy constants.
# The previous check printed PASS on both branches and never set FAIL.
# Worker source may import and read POLICY_DEFAULTS. It may not define that
# object, and it may not assign a canonical policy key to a numeric literal.
echo -n "[3/9] No inline policy constants... "
POLICY_FILE="$ROOT/shared-authority-core/src/policy-defaults.ts"
CHECK3_FAIL=0
CHECK3_HITS=""
if [ ! -f "$POLICY_FILE" ]; then
  echo "FAIL"
  echo "missing $POLICY_FILE"
  FAIL=1
else
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if printf '%s\n' "$line" | grep -qE '(^|[^A-Za-z0-9_])POLICY_DEFAULTS[[:space:]]*='; then
      CHECK3_HITS="${CHECK3_HITS}${line}"$'\n'
      CHECK3_FAIL=1
    fi
  done < <(grep -rn 'POLICY_DEFAULTS' "$ROOT/workers" --include='*.ts' 2>/dev/null || true)

  while IFS= read -r key; do
    [ -z "$key" ] && continue
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      if printf '%s\n' "$line" | grep -qE "(^|[^A-Za-z0-9_])${key}[[:space:]]*[:=][[:space:]]*-?[0-9]"; then
        CHECK3_HITS="${CHECK3_HITS}${line}"$'\n'
        CHECK3_FAIL=1
      fi
    done < <(grep -rn -- "$key" "$ROOT/workers" --include='*.ts' 2>/dev/null || true)
  done < <(grep -E '^[[:space:]]+[A-Z][A-Z0-9_]+:' "$POLICY_FILE" | sed -E 's/^[[:space:]]+([A-Z0-9_]+):.*/\1/')

  if [ "$CHECK3_FAIL" -eq 0 ]; then
    echo "PASS"
  else
    echo "FAIL"
    printf '%s' "$CHECK3_HITS"
    FAIL=1
  fi
fi

# 4. Every wrangler.toml has WORKER_ID
echo -n "[4/9] Every worker has WORKER_ID in wrangler.toml... "
CHECK4_FAIL=0
for toml in "$ROOT"/workers/*/wrangler.toml; do
  if ! grep -q 'WORKER_ID' "$toml" 2>/dev/null; then
    echo "FAIL ($(basename $(dirname $toml)))"; CHECK4_FAIL=1; break
  fi
done
if [ "$CHECK4_FAIL" -eq 0 ]; then echo "PASS"; else FAIL=1; fi

# 5. No .dev.vars committed
echo -n "[5/9] No .dev.vars committed... "
if find "$ROOT" -name '.dev.vars' -not -path '*/node_modules/*' 2>/dev/null | grep -q .; then
  echo "FAIL"; FAIL=1
else
  echo "PASS"
fi

# 6. No duplicate worker names in wrangler.toml files
echo -n "[6/9] No duplicate worker names... "
NAMES=$(grep -h '^name = ' "$ROOT"/workers/*/wrangler.toml 2>/dev/null | sort)
DUPES=$(echo "$NAMES" | uniq -d || true)
if [ -n "$DUPES" ]; then
  echo "FAIL ($DUPES)"; FAIL=1
else
  echo "PASS"
fi

# 7. Proof gate imported in forge and compiler
echo -n "[7/9] Proof gate used in forge and compiler... "
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
echo -n "[8/9] Content hash enforcement in forge... "
if grep -q 'computeContentHash' "$ROOT/workers/authority-content-forge/src/index.ts" 2>/dev/null; then
  echo "PASS"
else
  echo "FAIL"; FAIL=1
fi

# 9. Edge trust boundary — block proprietary computation in frontend (allow display-only POLICY_DEFAULTS)
echo -n "[9/9] Edge trust boundary (no proprietary computation in frontend)... "
if grep -rE 'computeAII|computeFullAII|generateCure|evaluateDimension|import.*from.*authority-engine|import.*from.*examiner' \
  "$ROOT/workers/411bz-frontend" --include='*.ts' 2>/dev/null | grep -q .; then
  echo "FAIL (proprietary computation in frontend)"; FAIL=1
else
  echo "PASS"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "All 9 guardrails PASSED."
  exit 0
else
  echo "GUARDRAILS FAILED — fix violations before merge."
  exit 1
fi
