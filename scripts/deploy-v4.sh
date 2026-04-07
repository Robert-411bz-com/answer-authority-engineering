#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# 411bz.ai Phase 4 Auth Release — One-Shot Deploy Script
# Commit: 2c0e73c on main (answer-authority-engineering)
# Version: 4.0.0
#
# This script deploys the canonical auth release.
# Run from the repo root: ./scripts/deploy-v4.sh
# ─────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  411bz.ai Phase 4 Auth Deploy — v4.0.0${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
echo ""

# ── Pre-flight checks ────────────────────────────────────────
echo -e "${YELLOW}[1/7] Pre-flight checks...${NC}"

if ! command -v wrangler &>/dev/null && ! command -v npx &>/dev/null; then
  echo -e "${RED}ERROR: wrangler not found. Run: npm install -g wrangler${NC}"
  exit 1
fi

WRANGLER="npx wrangler"
if command -v wrangler &>/dev/null; then
  WRANGLER="wrangler"
fi

# Verify we're in the right repo
if [[ ! -f workers/411bz-frontend/src/auth.ts ]]; then
  echo -e "${RED}ERROR: auth.ts not found. Are you in answer-authority-engineering root?${NC}"
  exit 1
fi

# Verify canonical naming — fail fast on any conflict
if [[ -f workers/411bz-frontend/src/tenant-auth.ts ]]; then
  echo -e "${RED}ERROR: tenant-auth.ts exists — delete it first${NC}"
  exit 1
fi

if grep -rq 'OBSERVATORY_DB' workers/ --include='*.ts'; then
  echo -e "${RED}ERROR: OBSERVATORY_DB reference found in .ts files${NC}"
  exit 1
fi

echo -e "${GREEN}  ✓ Canonical naming verified (auth.ts, DB, 4.0.0)${NC}"

# ── Pull latest ──────────────────────────────────────────────
echo -e "${YELLOW}[2/7] Pulling latest from origin/main...${NC}"
git pull origin main
echo -e "${GREEN}  ✓ Up to date${NC}"

# ── Deploy stripe (dependency order: frontend binds to stripe) ──
echo -e "${YELLOW}[3/7] Installing stripe worker dependencies...${NC}"
cd workers/411bz-stripe && npm install --silent
echo -e "${GREEN}  ✓ Dependencies installed${NC}"

echo -e "${YELLOW}[4/7] Deploying 411bz-stripe...${NC}"
$WRANGLER deploy
echo -e "${GREEN}  ✓ 411bz-stripe deployed${NC}"

# ── Deploy frontend ──────────────────────────────────────────
echo -e "${YELLOW}[5/7] Installing frontend worker dependencies...${NC}"
cd ../411bz-frontend && npm install --silent
echo -e "${GREEN}  ✓ Dependencies installed${NC}"

echo -e "${YELLOW}[6/7] Deploying 411bz-frontend...${NC}"
$WRANGLER deploy
echo -e "${GREEN}  ✓ 411bz-frontend deployed${NC}"

# ── Set TOKEN_SIGNING_SECRET ─────────────────────────────────
echo -e "${YELLOW}[7/7] Setting TOKEN_SIGNING_SECRET...${NC}"
echo -e "  Paste or type your secret when prompted (64+ hex chars recommended)."
echo -e "  Pre-generated option: ${GREEN}b68d0083b2b34bdc91f62630fc2ac20ab57ec66986688a03bed0376fef0a987d${NC}"
$WRANGLER secret put TOKEN_SIGNING_SECRET

cd ../..

# ── Verification ─────────────────────────────────────────────
echo ""
echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  Post-deploy verification${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
echo ""

# Check runtime version
echo -e "Checking runtime-config..."
VERSION=$(curl -sf https://api.411bz.ai/runtime-config 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','UNKNOWN'))" 2>/dev/null || echo "FETCH_FAILED")

if [[ "$VERSION" == "4.0.0" ]]; then
  echo -e "${GREEN}  ✓ Runtime version: $VERSION${NC}"
else
  echo -e "${RED}  ✗ Expected 4.0.0, got: $VERSION${NC}"
  echo -e "  Try: curl -s https://api.411bz.ai/runtime-config | jq '.version'"
fi

# Check stripe health
echo -e "Checking stripe health..."
STRIPE_HEALTH=$(curl -sf https://411bz-stripe.bob-0a9.workers.dev/health 2>/dev/null || echo "FETCH_FAILED")
echo -e "  Stripe: $STRIPE_HEALTH"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Deploy complete. Auth is INACTIVE until${NC}"
echo -e "${GREEN}  TOKEN_SIGNING_SECRET is confirmed set.${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
