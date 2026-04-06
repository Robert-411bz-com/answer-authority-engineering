#!/usr/bin/env bash
# Deploy all workers in dependency order.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== 411bz Deploy All Workers ==="
echo "Running guardrails first..."
bash "$ROOT/scripts/ci-guardrails.sh"

DEPLOY_ORDER=(
  "411bz-authority-engine"
  "authority-examiner"
  "authority-solution-compiler"
  "authority-content-forge"
  "411bz-observatory"
  "411bz-orchestrator"
  "411bz-schema-engine"
  "411bz-stripe"
  "411bz-boss-ai"
  "411bz-audit"
  "411bz-dashboard"
  "411bz-operator-workbench"
  "411bz-frontend"
)

for worker in "${DEPLOY_ORDER[@]}"; do
  echo ""
  echo "--- Deploying $worker ---"
  cd "$ROOT/workers/$worker"
  npx wrangler deploy
  echo "--- $worker deployed ---"
done

echo ""
echo "=== All workers deployed ==="
