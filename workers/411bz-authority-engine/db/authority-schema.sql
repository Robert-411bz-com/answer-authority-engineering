-- 411bz Authority Engine — D1 Schema (24 tables)
-- All authority data: tenants, claims, scores, evidence, connectors

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE, business_name TEXT NOT NULL,
  business_type TEXT, plan TEXT DEFAULT 'trial', status TEXT DEFAULT 'active',
  policy_overrides TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  category TEXT NOT NULL, claim_text TEXT NOT NULL, source_type TEXT NOT NULL,
  source_url TEXT, confidence REAL DEFAULT 0, verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS scores (
  score_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  score_type TEXT NOT NULL, dimension TEXT, score_value REAL NOT NULL,
  provenance TEXT NOT NULL, computed_at TEXT DEFAULT (datetime('now')), version INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  source_type TEXT NOT NULL, source_url TEXT NOT NULL, content_hash TEXT NOT NULL,
  confidence REAL DEFAULT 0, extracted_at TEXT DEFAULT (datetime('now')), metadata TEXT
);
CREATE TABLE IF NOT EXISTS cures (
  cure_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  diagnosis_id TEXT NOT NULL, category TEXT NOT NULL, action_type TEXT NOT NULL,
  target TEXT NOT NULL, instructions TEXT NOT NULL, evidence_ids TEXT NOT NULL,
  priority INTEGER DEFAULT 0, estimated_impact REAL DEFAULT 0, confidence REAL DEFAULT 0,
  status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS diagnoses (
  diagnosis_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  category TEXT NOT NULL, severity TEXT NOT NULL, description TEXT NOT NULL,
  evidence_ids TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  kind TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
  cure_refs TEXT, version INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), metadata TEXT
);
CREATE TABLE IF NOT EXISTS connectors (
  connector_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  connector_type TEXT NOT NULL, config TEXT NOT NULL, status TEXT DEFAULT 'active',
  last_sync TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS connector_runs (
  run_id TEXT PRIMARY KEY, connector_id TEXT NOT NULL REFERENCES connectors(connector_id),
  tenant_id TEXT NOT NULL, status TEXT NOT NULL, records_fetched INTEGER DEFAULT 0,
  errors TEXT, started_at TEXT DEFAULT (datetime('now')), completed_at TEXT
);
CREATE TABLE IF NOT EXISTS probes (
  probe_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  probe_type TEXT NOT NULL, target_url TEXT NOT NULL, result TEXT,
  status_code INTEGER, latency_ms INTEGER, probed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, score_type TEXT NOT NULL,
  dimension TEXT, score_value REAL NOT NULL, computed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS competitive_profiles (
  profile_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  competitor_domain TEXT NOT NULL, competitor_name TEXT, last_analyzed TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS competitive_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES competitive_profiles(profile_id),
  dimension TEXT NOT NULL, score_value REAL NOT NULL, computed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS weight_tuning (
  tuning_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, dimension TEXT NOT NULL,
  old_weight REAL NOT NULL, new_weight REAL NOT NULL, reason TEXT,
  applied_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS visibility_snapshots (
  snapshot_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  llm_provider TEXT NOT NULL, query TEXT NOT NULL, position INTEGER,
  cited INTEGER DEFAULT 0, snapshot_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, actor TEXT NOT NULL,
  action TEXT NOT NULL, resource_type TEXT, resource_id TEXT, details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  key_hash TEXT NOT NULL, name TEXT, scopes TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')), expires_at TEXT, revoked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS webhooks (
  webhook_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  url TEXT NOT NULL, events TEXT NOT NULL, secret_hash TEXT NOT NULL,
  status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
  category_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, parent_category TEXT,
  description TEXT, weight REAL DEFAULT 1.0, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS category_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, category_id TEXT NOT NULL,
  score_value REAL NOT NULL, evidence_count INTEGER DEFAULT 0,
  computed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deployments (
  deployment_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, artifact_ids TEXT NOT NULL,
  verdict TEXT NOT NULL, deployed_at TEXT DEFAULT (datetime('now')), deployed_by TEXT
);
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY, type TEXT NOT NULL, days_free INTEGER NOT NULL,
  active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO promo_codes (code, type, days_free) VALUES ('FREE30', 'trial', 30);
INSERT OR IGNORE INTO promo_codes (code, type, days_free) VALUES ('FREE90', 'trial', 90);
CREATE TABLE IF NOT EXISTS affiliates (
  affiliate_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, affiliate_code TEXT NOT NULL UNIQUE,
  commission_type TEXT NOT NULL, commission_rate REAL NOT NULL,
  status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS affiliate_referrals (
  referral_id TEXT PRIMARY KEY, affiliate_id TEXT NOT NULL REFERENCES affiliates(affiliate_id),
  referred_tenant_id TEXT NOT NULL, commission_earned REAL DEFAULT 0,
  paid INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
