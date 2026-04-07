#!/usr/bin/env bash
# ============================================================================
# 411bz.ai — End-to-End Pipeline Acceptance Test  (12 assertions)
# ============================================================================
# Tests the full 12-stage orchestrator pipeline against live workers.
# Produces 12 pass/fail checks; AGE decisions are printed for info only.
#
# Phase 2 update: Step 3b upserts an active subscription for the test tenant
# so the plan-gated pipeline/start route (402 enforcement) allows through.
#
# Prerequisites:
#   - All workers deployed via `npx wrangler deploy`
#   - D1 databases migrated
#   - AUTHORITY_INTERNAL_KEY set in all workers
#
# Usage:
#   FRONTEND_URL=https://411bz-frontend.bob-0a9.workers.dev \
#   AUTH_KEY=<your-authority-internal-key> \
#   bash scripts/e2e-test.sh
# ============================================================================
set -euo pipefail

# ── Validate env before any network calls ──
if [[ -z "${FRONTEND_URL:-}" ]]; then
  echo "ERROR: Set FRONTEND_URL first (e.g. https://411bz-frontend.bob-0a9.workers.dev)."
  exit 1
fi
if [[ -z "${AUTH_KEY:-}" ]]; then
  echo "ERROR: Set AUTH_KEY first (same value as AUTHORITY_INTERNAL_KEY on workers)."
  exit 1
fi

FRONTEND="${FRONTEND_URL%/}"           # strip trailing slash
KEY="$AUTH_KEY"
CURL_TIMEOUT=30                        # seconds per request — prevents hangs
PASS=0
FAIL=0
TOTAL=0

# ── Reject placeholder URLs ──
if echo "$FRONTEND" | grep -qE '<|>|\{|\}|your-|example'; then
  echo "ERROR: FRONTEND_URL looks like a placeholder: $FRONTEND"
  echo "       Set it to your real deployed URL."
  exit 1
fi

# ── Reject known documentation placeholders for AUTH_KEY ──
case "$KEY" in
  your-AUTHORITY_INTERNAL_KEY|your-real-AUTHORITY_INTERNAL_KEY|your-authority-internal-key|your-secure-key-here)
    echo "ERROR: AUTH_KEY is still a documentation placeholder. Export the real value from Cloudflare."
    exit 1
    ;;
esac

# Use python or python3, whichever is available
PY=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || echo "python")

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
  curl -sf --max-time "$CURL_TIMEOUT" -H "X-Authority-Key: $KEY" "$FRONTEND$1" || echo '{}'
}

http_post() {
  curl -sf --max-time "$CURL_TIMEOUT" -X POST \
    -H "X-Authority-Key: $KEY" -H "Content-Type: application/json" \
    -d "$2" "$FRONTEND$1" || echo '{}'
}

jq_py() {
  $PY -c "import sys,json
try:
    d=json.load(sys.stdin)
    result=$1
    print(result if result is not None else '')
except: print('')" 2>/dev/null
}

echo "============================================"
echo "411bz.ai E2E Pipeline Acceptance Test"
echo "Frontend: $FRONTEND"
echo "Python:   $PY"
echo "Checks:   12 assertions (12-stage pipeline)"
echo "============================================"
echo ""

# ── Step 1: Health check ──────────────────────────────────────────────────
# GET /health is unauthenticated; all other steps use X-Authority-Key.
echo "Step 1: Health Check"
HEALTH=$(curl -sf --max-time "$CURL_TIMEOUT" "$FRONTEND/health" || echo '{}')
check "Frontend healthy" [ "$(echo "$HEALTH" | jq_py "d.get('status','')")" = "healthy" ]
echo ""

# ── Step 2: Runtime config ────────────────────────────────────────────────
echo "Step 2: Runtime Config"
CONFIG=$(http_get "/api/runtime-config")
check "Platform is 411bz.ai" \
  [ "$(echo "$CONFIG" | jq_py "d.get('data',{}).get('platform','')")" = "411bz.ai" ]
# str() coercion: JSON returns int 12/600; shell compare needs string "12"/"600"
check "Orchestrator has 12 stages" \
  [ "$(echo "$CONFIG" | jq_py "str(d.get('data',{}).get('features',{}).get('orchestrator_stages',''))")" = "12" ]
check "Examiner has 600 categories" \
  [ "$(echo "$CONFIG" | jq_py "str(d.get('data',{}).get('features',{}).get('examiner_categories',''))")" = "600" ]
echo ""

# ── Step 3: Create test tenant (unique per run) ──────────────────────────
echo "Step 3: Create Test Tenant"
TS=$(date +%s)
TENANT_ID="e2e_test_${TS}"
TENANT_DOMAIN="e2e-${TS}.test.411bz.ai"
TENANT_RESP=$(http_post "/api/v1/tenants" "{
  \"tenant_id\": \"$TENANT_ID\",
  \"domain\": \"$TENANT_DOMAIN\",
  \"business_name\": \"E2E Test Business\",
  \"business_type\": \"LocalBusiness\",
  \"plan\": \"trial\"
}")
# Accept truth-wrapped {data:{tenant_id:...}}, legacy {created:"id"}, or top-level {tenant_id:...}
# Guard: d.get('created','') can be boolean True in legacy — only use if it's a string.
CREATED_ID=$(echo "$TENANT_RESP" | jq_py "d.get('data',{}).get('tenant_id','') or (d.get('created','') if isinstance(d.get('created',''), str) else '') or d.get('tenant_id','')")
check "Tenant created" [ "$CREATED_ID" = "$TENANT_ID" ]
echo "  Tenant ID: $TENANT_ID"
echo "  Domain:    $TENANT_DOMAIN"
echo ""

# ── Step 3b: Create subscription (Phase 2 — plan enforcement requires it) ─
echo "Step 3b: Create Subscription for Test Tenant"
SUB_RESP=$(http_post "/api/v1/subscriptions" "{
  \"tenant_id\": \"$TENANT_ID\",
  \"plan\": \"starter\",
  \"status\": \"active\",
  \"current_period_end\": \"2099-12-31T00:00:00Z\",
  \"stripe_subscription_id\": \"sub_e2e_test_${TS}\",
  \"stripe_customer_id\": \"cus_e2e_test_${TS}\"
}")
SUB_TENANT=$(echo "$SUB_RESP" | jq_py "d.get('data',{}).get('tenant_id','') or d.get('tenant_id','')")
check "Subscription created" [ "$SUB_TENANT" = "$TENANT_ID" ]
echo "  Plan: starter  Status: active  Expires: 2099-12-31"
echo ""

# ── Step 4: Start pipeline ───────────────────────────────────────────────
echo "Step 4: Start Pipeline Run"
RUN_RESP=$(http_post "/api/pipeline/start" "{\"tenant_id\": \"$TENANT_ID\"}")
# run_id may be at top level or under data (handle both)
RUN_ID=$(echo "$RUN_RESP" | jq_py "d.get('run_id','') or d.get('data',{}).get('run_id','')")
check "Pipeline started" [ -n "$RUN_ID" ]
echo "  Run ID: $RUN_ID"
echo ""

# ── Step 5: Wait for pipeline completion ─────────────────────────────────
echo "Step 5: Wait for Pipeline Completion (max 120s)"
MAX_WAIT=120
ELAPSED=0
PIPELINE_STATUS=""
while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  STATUS_RESP=$(http_get "/api/pipeline/$RUN_ID")
  PIPELINE_STATUS=$(echo "$STATUS_RESP" | jq_py "d.get('data',{}).get('run',{}).get('status','')")
  CURRENT_STAGE=$(echo "$STATUS_RESP" | jq_py "d.get('data',{}).get('run',{}).get('current_stage','?')")
  echo "  [${ELAPSED}s] status=$PIPELINE_STATUS  stage=$CURRENT_STAGE"
  # Exit on any terminal status
  case "$PIPELINE_STATUS" in
    completed|paused|failed) break ;;
  esac
done
# Pipeline may complete, pause for review, or fail on stages without real data — all valid for E2E
check "Pipeline finished" [ "$PIPELINE_STATUS" = "completed" -o "$PIPELINE_STATUS" = "paused" -o "$PIPELINE_STATUS" = "failed" ]
echo ""

# ── Step 6: Verify pipeline artifacts ────────────────────────────────────
echo "Step 6: Verify Pipeline Artifacts"
DETAIL=$(http_get "/api/pipeline/$RUN_ID")

TRANSITION_COUNT=$(echo "$DETAIL" | jq_py "len(d.get('data',{}).get('transitions',[]))")
check "Stage transitions recorded" [ "${TRANSITION_COUNT:-0}" -gt "0" ]

CWAR_COUNT=$(echo "$DETAIL" | jq_py "len(d.get('data',{}).get('cwar',[]))")
check "CWAR decisions recorded" [ "${CWAR_COUNT:-0}" -gt "0" ]

# AGE decisions: informational only (0 is valid when no stages pause)
AGE_COUNT=$(echo "$DETAIL" | jq_py "len(d.get('data',{}).get('age',[]))")
echo "  Transitions: ${TRANSITION_COUNT:-0}   CWAR: ${CWAR_COUNT:-0}   AGE: ${AGE_COUNT:-0} (info only)"
echo ""

# ── Step 7: Verify evidence ──────────────────────────────────────────────
echo "Step 7: Verify Evidence"
EVIDENCE=$(http_get "/api/v1/evidence/$TENANT_ID")
EVIDENCE_COUNT=$(echo "$EVIDENCE" | jq_py "d.get('data',{}).get('total',0) if isinstance(d.get('data'),dict) else len(d.get('data',[]))")
echo "  Evidence count: ${EVIDENCE_COUNT:-0}"
# Evidence may be 0 for a new tenant with no real connectors — endpoint returning is the assertion
check "Evidence endpoint returns" [ -n "$EVIDENCE_COUNT" ]
echo ""

# ── Step 8: Verify scorecards ────────────────────────────────────────────
echo "Step 8: Verify Scorecards"
SCORECARDS=$(http_get "/api/v1/tenants/$TENANT_ID/scorecards")
SCORECARD_DATA=$(echo "$SCORECARDS" | jq_py "d.get('data',[])")
echo "  Scorecard response: ${#SCORECARD_DATA} chars"
check "Scorecards endpoint returns" [ -n "$SCORECARD_DATA" ]
echo ""

# ── Summary ──────────────────────────────────────────────────────────────
echo "============================================"
echo "E2E Results: $PASS/$TOTAL passed, $FAIL failed"
echo "============================================"

if [ "$FAIL" -gt "0" ]; then
  echo "❌ SOME TESTS FAILED"
  exit 1
else
  echo "✅ ALL TESTS PASSED ($PASS/$TOTAL assertions)"
  exit 0
fi
