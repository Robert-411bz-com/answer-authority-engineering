-- Orchestrator D1 Schema — pipeline runs, stage transitions, CPR checkpoints
CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, current_stage TEXT NOT NULL,
  status TEXT DEFAULT 'running', checkpoint TEXT, started_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS stage_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id),
  from_stage TEXT NOT NULL, to_stage TEXT NOT NULL, confidence REAL,
  decision TEXT NOT NULL, transitioned_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cpr_checkpoints (
  checkpoint_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id),
  stage TEXT NOT NULL, state_snapshot TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS age_decisions (
  decision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id),
  stage TEXT NOT NULL, action TEXT NOT NULL, confidence REAL NOT NULL,
  outcome TEXT NOT NULL, decided_at TEXT DEFAULT (datetime('now'))
);
