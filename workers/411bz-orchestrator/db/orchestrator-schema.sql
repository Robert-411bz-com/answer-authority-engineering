-- Orchestrator D1 Schema — pipeline runs, stage transitions, CPR checkpoints, CWAR, AGE
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
CREATE TABLE IF NOT EXISTS cwar_decisions (
  decision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id),
  stage TEXT NOT NULL, confidence REAL NOT NULL,
  reject_threshold REAL NOT NULL, review_threshold REAL NOT NULL,
  decision TEXT NOT NULL, decided_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS age_decisions (
  decision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id),
  stage TEXT NOT NULL, action TEXT NOT NULL, confidence REAL NOT NULL,
  outcome TEXT NOT NULL, decided_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transitions_run ON stage_transitions(run_id);
CREATE INDEX IF NOT EXISTS idx_cpr_run ON cpr_checkpoints(run_id);
CREATE INDEX IF NOT EXISTS idx_cwar_run ON cwar_decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_age_run ON age_decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_tenant ON pipeline_runs(tenant_id);

-- ── Fabric decision gate (FABRIC_MODE off | shadow | gate) ──
-- One slip per question per evaluation. subject = what the question was about (tenant domain,
-- diagnosis id). detail_json = structural checks, conjunction rule, error text, shadow local score.
-- A failed Jev call writes winner/primary_p/peakedness NULL and probabilities_json '{}'; nothing is synthesized.
CREATE TABLE IF NOT EXISTS fabric_slips (
  slip_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  question_id TEXT NOT NULL,
  subject TEXT,
  content_hash TEXT,
  lane TEXT NOT NULL,
  winner TEXT,
  primary_p REAL,
  peakedness REAL,
  probabilities_json TEXT NOT NULL,
  cwar TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  model_id TEXT,
  detail_json TEXT,
  decided_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fabric_replay (
  replay_key TEXT PRIMARY KEY,  -- question_id || ':' || content_hash
  probabilities_json TEXT NOT NULL,
  winner TEXT NOT NULL,
  primary_p REAL NOT NULL,
  peakedness REAL NOT NULL,
  source_slip_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fabric_labels (
  label_id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  slip_id TEXT,
  agreed INTEGER NOT NULL,
  labeled_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fabric_calibration (
  question_id TEXT PRIMARY KEY,
  labels INTEGER NOT NULL DEFAULT 0,
  local_brier REAL,
  jev_brier REAL,
  mode TEXT NOT NULL DEFAULT 'auto'
);
CREATE INDEX IF NOT EXISTS idx_fabric_slips_run ON fabric_slips(run_id);
CREATE INDEX IF NOT EXISTS idx_fabric_slips_question ON fabric_slips(question_id);
CREATE INDEX IF NOT EXISTS idx_fabric_labels_question ON fabric_labels(question_id);
-- Seed: citation_ready stays shadow until real observatory labels exist. Every other semantic
-- question is auto. Structural and conjunction questions have no calibration row.
INSERT OR IGNORE INTO fabric_calibration (question_id, mode) VALUES
  ('entity_defined', 'auto'), ('gap_severity', 'auto'), ('cure_family', 'auto'),
  ('claim_supported', 'auto'), ('deploy_route', 'auto'),
  ('citation_ready', 'shadow'), ('citation_outcome', 'auto'),
  ('utterance_intent', 'auto'), ('utterance_urgent', 'auto'), ('utterance_pii', 'auto');
