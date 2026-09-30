#!/usr/bin/env bash
# Production-overwrite guard for this repo's deploy scripts.
#
# This repo deploys into the same Cloudflare account as 411bz-ai, and some worker
# names are shared. Deploying one of them from here replaces the 411bz-ai worker
# of the same name (live /health on 2026-09-30: 411bz-boss-ai and 411bz-frontend
# run 411bz-ai production code).
#
# Usage (first action in a deploy script, before any other command):
#   source "<repo>/scripts/lib/production-guard.sh"
#   require_production_overwrite_ack "<script name>" worker-a worker-b ...
#
# Always prints the workers the script would deploy. Exits 1 unless
# I_UNDERSTAND_THIS_OVERWRITES_PRODUCTION is exactly "yes".

SHARED_WITH_411BZ_AI=("411bz-boss-ai" "411bz-frontend" "411bz-observatory")

require_production_overwrite_ack() {
  local script="$1"
  shift
  echo "$script would deploy these Cloudflare workers (account shared with 411bz-ai):"
  local worker shared
  for worker in "$@"; do
    shared=""
    for s in "${SHARED_WITH_411BZ_AI[@]}"; do
      [[ "$worker" == "$s" ]] && shared="   <-- same name as a 411bz-ai worker; deploying overwrites it"
    done
    echo "  - ${worker}${shared}"
  done

  if [[ "${I_UNDERSTAND_THIS_OVERWRITES_PRODUCTION:-}" != "yes" ]]; then
    echo "REFUSING TO DEPLOY. Nothing was deployed." >&2
    echo "These workers can overwrite production. To proceed, set I_UNDERSTAND_THIS_OVERWRITES_PRODUCTION=yes" >&2
    exit 1
  fi
  echo "I_UNDERSTAND_THIS_OVERWRITES_PRODUCTION=yes: continuing."
}
