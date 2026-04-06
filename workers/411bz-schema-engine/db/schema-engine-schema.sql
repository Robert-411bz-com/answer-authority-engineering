-- Schema Engine D1 Schema — exam results, schema generations
CREATE TABLE IF NOT EXISTS schema_exams (
  exam_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, domain TEXT NOT NULL,
  findings TEXT NOT NULL, score REAL NOT NULL,
  examined_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS schema_generations (
  generation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, domain TEXT NOT NULL,
  schemas TEXT NOT NULL, content_hash TEXT NOT NULL,
  generated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exams_tenant ON schema_exams(tenant_id);
CREATE INDEX IF NOT EXISTS idx_generations_tenant ON schema_generations(tenant_id);
