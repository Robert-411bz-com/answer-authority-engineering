#!/usr/bin/env bash
# ============================================================================
# 411bz.ai — End-to-End Pipeline Acceptance Test
# ============================================================================
# Tests the full 12-stage orchestrator pipeline against live workers.
#
# Prerequisites:
#   - All workers deployed via `npx wrangler deploy`
#   - D1 databases migrated
#   - AUTHORITY_INTERNAL_KEY set in all workers
#
# Usage:
#   export FRONTEND_URL="https://411bz-frontend.<account>.workers.dev"
#   export AUTH_KEY='your-authority-internal-key'   # single quotes avoid shell metachar issues
#   ./scripts/e2e-test.sh
# ============================================================================
set -euo pipefail

FRONTEND="${FRONTEND_URL:?Set FRONTEND_URL}"
KEY="${AUTH_KEY:?Set AUTH_KEY}"
PASS=0
FAIL=0
TOTAL=0

check() {
  local label="$1"; shift
  TOTAL=$((TOTAL + 1))
  if "$@"; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label"
    FAIL=$((FAIL + 1))
  fi
}

http_get() {
  curl -sf -H "X-Authority-Key: $KEY" "$FRONTEND$1"
}

http_post() {
  curl -sf -X POST -H "X-Authority-Key: $KEY" -H "Content-Type: application/json" -d "$2" "$FRONTEND$1"
}

echo "============================================"
echo "411bz.ai E2E Pipeline Acceptance Test"
echo "Frontend: $FRONTEND"
echo "============================================"
echo ""

# ── Step 1: Health checks ──
echo "Step 1: Health Checks"
check "Frontend healthy" http_get "/health"
echo ""

# ── Step 2: Runtime config ──
echo "Step 2: Runtime Config"
CONFIG=$(http_get "/api/runtime-config" || echo '{}')
check "Runtime config returns data" [ "$(echo "$CONFIG" | python -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("platform",""))' 2>/dev/null)" = "411bz.ai" ]
check "Runtime config has 12 stages" [ "$(echo "$CONFIG" | python -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("features",{}).get("orchestrator_stages",0))' 2>/dev/null)" = "12" ]
check "Runtime config has 600 categories" [ "$(echo "$CONFIG" | python -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("features",{}).get("examiner_categories",0))' 2>/dev/null)" = "600" ]
echo ""

# ── Step 3: Create test tenant ──
echo "Step 3: Create Test Tenant"
TENANT_ID="e2e_test_$(date +%s)"
TENANT_RESP=$(http_post "/api/v1/tenants" "{
  \"tenant_id\": \"$TENANT_ID\",
  \"domain\": \"example.com\",
  \"business_name\": \"E2E Test Business\",
  \"business_type\": \"LocalBusiness\",
  \"plan\": \"free30\"
}" || echo '{}')
check "Tenant created" [ "$(echo "$TENANT_RESP" | python -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("tenant_id",""))' 2>/dev/null)" = "$TENANT_ID" ]
echo ""

# ── Step 4: Start pipeline ──
echo "Step 4: Start Pipeline Run"
RUN_RESP=$(http_post "/api/pipeline/start" "{\"tenant_id\": \"$TENANT_ID\"}" || echo '{}')
RUN_ID=$(echo "$RUN_RESP" | python -c 'import sys,json; d=json.load(sys.stdin); print(d.get("run_id",""))' 2>/dev/null || echo "")
check "Pipeline started" [ -n "$RUN_ID" ]
echo "  Run ID: $RUN_ID"
echo ""

# ── Step 5: Wait for pipeline completion ──
echo "Step 5: Wait for Pipeline Completion (max 120s)"
MAX_WAIT=120
ELAPSED=0
PIPELINE_STATUS="running"
while [ "$ELAPSED" -lt "$MAX_WAIT" ] && [ "$PIPELINE_STATUS" = "running" ]; do
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  STATUS_RESP=$(http_get "/api/pipeline/$RUN_ID" || echo '{}')
  PIPELINE_STATUS=$(echo "$STATUS_RESP" | python -c 'import sys,json; d=json.load(sys.stdin); r=d.get("data",{}).get("run",{}); print(r.get("status","unknown"))' 2>/dev/null || echo "unknown")
  echo "  [$ELAPSED s] Status: $PIPELINE_STATUS"
done
check "Pipeline completed or paused" [ "$PIPELINE_STATUS" = "completed" ] || [ "$PIPELINE_STATUS" = "paused" ]
echo ""

# ── Step 6: Verify pipeline artifacts ──
echo "Step 6: Verify Pipeline Artifacts"
DETAIL=$(http_get "/api/pipeline/$RUN_ID" || echo '{}')

# Check transitions exist
TRANSITION_COUNT=$(echo "$DETAIL" | python -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("data",{}).get("transitions",[])))' 2>/dev/null || echo "0")
check "Stage transitions recorded" [ "$TRANSITION_COUNT" -gt "0" ]

# Check CWAR decisions exist
CWAR_COUNT=$(echo "$DETAIL" | python -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("data",{}).get("cwar",[])))' 2>/dev/null || echo "0")
check "CWAR decisions recorded" [ "$CWAR_COUNT" -gt "0" ]

# Check AGE decisions (may be 0 if no pauses)
AGE_COUNT=$(echo "$DETAIL" | python -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("data",{}).get("age",[])))' 2>/dev/null || echo "0")
echo "  AGE decisions: $AGE_COUNT (0 is valid if no pauses)"
echo ""

# ── Step 7: Verify evidence ──
echo "Step 7: Verify Evidence"
EVIDENCE=$(http_get "/api/v1/evidence/$TENANT_ID" || echo '{}')
EVIDENCE_COUNT=$(echo "$EVIDENCE" | python -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("total",0) if isinstance(d.get("data"),dict) else len(d.get("data",[])))' 2>/dev/null || echo "0")
check "Evidence exists for tenant" [ "$EVIDENCE_COUNT" -gt "0" ] || true
echo "  Evidence count: $EVIDENCE_COUNT"
echo ""

# ── Step 8: Verify scorecards ──
echo "Step 8: Verify Scorecards"
SCORECARDS=$(http_get "/api/v1/scorecards" || echo '{}')
SCORECARD_COUNT=$(echo "$SCORECARDS" | python -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("data",[])))' 2>/dev/null || echo "0")
check "Scorecards exist" [ "$SCORECARD_COUNT" -gt "0" ] || true
echo "  Scorecard count: $SCORECARD_COUNT"
echo ""

# ── Step 9: Verify artifacts ──
echo "Step 9: Verify Artifacts"
ARTIFACTS=$(http_get "/api/v1/tenants/$TENANT_ID/artifacts" || echo '{}')
ARTIFACT_COUNT=$(echo "$ARTIFACTS" | python -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("data",[])))' 2>/dev/null || echo "0")
check "Artifacts exist for tenant" [ "$ARTIFACT_COUNT" -gt "0" ] || true
echo "  Artifact count: $ARTIFACT_COUNT"
echo ""

# ── Step 10: Verify content hashes ──
echo "Step 10: Verify Content Hashes"
if [ "$ARTIFACT_COUNT" -gt "0" ]; then
  FIRST_HASH=$(echo "$ARTIFACTS" | python -c 'import sys,json; d=json.load(sys.stdin); arts=d.get("data",[]); print(arts[0].get("content_hash","") if arts else "")' 2>/dev/null || echo "")
  check "Artifact has SHA-256 hash" [ ${#FIRST_HASH} -eq 64 ]
else
  echo "  (skipped — no artifacts)"
fi
echo ""

# ── Summary ──
echo "============================================"
echo "E2E Test Results: $PASS passed, $FAIL failed, $TOTAL total"
echo "============================================"

if [ "$FAIL" -gt "0" ]; then
  echo "❌ SOME TESTS FAILED"
  exit 1
else
  echo "✅ ALL TESTS PASSED"
  exit 0
fi
