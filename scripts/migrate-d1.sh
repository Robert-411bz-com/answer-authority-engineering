#!/usr/bin/env bash
# Apply D1 schema migrations for all databases.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== 411bz D1 Migrations ==="

MIGRATIONS=(
  "411bz-authority-engine:authority-production:db/authority-schema.sql"
  "411bz-orchestrator:orchestrator-production:db/orchestrator-schema.sql"
  "authority-content-forge:forge-production:db/forge-schema.sql"
)

for entry in "${MIGRATIONS[@]}"; do
  IFS=':' read -r worker db schema <<< "$entry"
  echo ""
  echo "--- Migrating $db ($worker) ---"
  cd "$ROOT/workers/$worker"
  if [ -f "$schema" ]; then
    npx wrangler d1 execute "$db" --file="$schema"
    echo "--- $db migrated ---"
  else
    echo "WARN: Schema file $schema not found, skipping"
  fi
done

echo ""
echo "=== All migrations complete ==="
