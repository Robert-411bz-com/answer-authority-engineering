/**
 * Canonical naming for all authority platform entities.
 * Single source of truth — no worker may invent its own naming.
 */

export const CANONICAL_WORKERS = {
  ENGINE:    '411bz-authority-engine',
  ORCHESTRATOR: '411bz-orchestrator',
  FORGE:     'authority-content-forge',
  COMPILER:  'authority-solution-compiler',
  EXAMINER:  'authority-examiner',
  WORKBENCH: '411bz-operator-workbench',
  FRONTEND:  '411bz-frontend',
  STRIPE:    '411bz-stripe',
  OBSERVATORY: '411bz-observatory',
  BOSS_AI:   '411bz-boss-ai',
  SCHEMA:    '411bz-schema-engine',
  DASHBOARD: '411bz-dashboard',
  AUDIT:     '411bz-audit',
} as const;

export type CanonicalWorker = typeof CANONICAL_WORKERS[keyof typeof CANONICAL_WORKERS];

export const CANONICAL_DATABASES = {
  AUTHORITY: 'authority-production',
  ORCHESTRATOR: 'orchestrator-production',
  FORGE: 'forge-production',
} as const;

export function assertCanonicalWorker(name: string): asserts name is CanonicalWorker {
  const valid = Object.values(CANONICAL_WORKERS) as string[];
  if (!valid.includes(name)) {
    throw new Error(`Non-canonical worker name: "${name}". Valid: ${valid.join(', ')}`);
  }
}
