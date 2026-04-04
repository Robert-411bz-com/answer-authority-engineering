-- Content Forge D1 Schema
CREATE TABLE IF NOT EXISTS generation_jobs (
  job_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL,
  prompt TEXT NOT NULL, status TEXT DEFAULT 'pending', content TEXT,
  content_hash TEXT, cure_refs TEXT, model_used TEXT,
  created_at TEXT DEFAULT (datetime('now')), completed_at TEXT
);
CREATE TABLE IF NOT EXISTS generation_templates (
  template_id TEXT PRIMARY KEY, kind TEXT NOT NULL, template_text TEXT NOT NULL,
  version INTEGER DEFAULT 1, active INTEGER DEFAULT 1
);
