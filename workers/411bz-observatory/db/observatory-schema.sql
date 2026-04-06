-- Observatory D1 Schema — probes, deployments, verifications, entities
CREATE TABLE IF NOT EXISTS probes (
  probe_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, domain TEXT NOT NULL,
  results TEXT NOT NULL, probed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deployments (
  deployment_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, run_id TEXT,
  artifact_ids TEXT NOT NULL, verdict TEXT NOT NULL,
  dry_run INTEGER DEFAULT 0, deployed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS verifications (
  verification_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  deployment_id TEXT, verdict TEXT NOT NULL,
  results TEXT NOT NULL, verified_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL, canonical_domain TEXT NOT NULL,
  surfaces TEXT NOT NULL DEFAULT '[]',
  resolved_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_probes_tenant ON probes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_deployments_tenant ON deployments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_entities_tenant ON entities(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_domain ON entities(tenant_id, canonical_domain);
