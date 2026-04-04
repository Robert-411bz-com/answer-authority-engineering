/**
 * 411bz-orchestrator — 12-stage state machine.
 * CPR: Checkpoint/Pause/Resume
 * CWAR: Confidence-Weighted Action Routing
 * AGE: Authority Governance Engine
 */

import { Hono } from 'hono';
import { assertTenantId, wrapTruth, generateRequestId, POLICY_DEFAULTS, CANONICAL_WORKERS } from 'shared-authority-core';

const STAGES = [
  'ingest', 'crawl_normalize', 'examine', 'evidence_graph',
  'diagnosis', 'compile_cures', 'forge_content', 'deploy_dry_run',
  'deploy', 'remeasure', 'compare_deltas', 'publish_scorecard',
] as const;
type Stage = typeof STAGES[number];

type Bindings = {
  DB: D1Database;
  ENGINE: Fetcher;
  EXAMINER: Fetcher;
  COMPILER: Fetcher;
  FORGE: Fetcher;
  OBSERVATORY: Fetcher;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('/v1/*', async (c, next) => {
  const key = c.req.header('X-Authority-Key');
  if (key !== c.env.AUTHORITY_INTERNAL_KEY) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID, stages: STAGES.length }));

// ── Start pipeline ──
app.post('/v1/pipeline/start', async (c) => {
  const body = await c.req.json<{ tenant_id: string }>();
  assertTenantId(body.tenant_id);
  const runId = `run_${body.tenant_id.substring(0, 8)}_${Date.now().toString(36)}`;
  await c.env.DB.prepare(
    'INSERT INTO pipeline_runs (run_id, tenant_id, current_stage, status) VALUES (?, ?, ?, ?)'
  ).bind(runId, body.tenant_id, 'ingest', 'running').run();
  // Begin async execution
  c.executionCtx.waitUntil(executePipeline(c.env, runId, body.tenant_id));
  return c.json({ run_id: runId, status: 'started', stage: 'ingest' }, 201);
});

// ── Get pipeline status ──
app.get('/v1/pipeline/:run_id', async (c) => {
  const runId = c.req.param('run_id');
  const run = await c.env.DB.prepare('SELECT * FROM pipeline_runs WHERE run_id = ?').bind(runId).first();
  if (!run) return c.json({ error: 'run_not_found' }, 404);
  const transitions = await c.env.DB.prepare(
    'SELECT * FROM stage_transitions WHERE run_id = ? ORDER BY transitioned_at'
  ).bind(runId).all();
  return c.json(wrapTruth({ run, transitions: transitions.results }, c.env.WORKER_ID, generateRequestId()));
});

// ── Resume from checkpoint (CPR) ──
app.post('/v1/pipeline/:run_id/resume', async (c) => {
  const runId = c.req.param('run_id');
  const run = await c.env.DB.prepare('SELECT * FROM pipeline_runs WHERE run_id = ?').bind(runId).first<{ run_id: string; tenant_id: string; current_stage: string; status: string }>();
  if (!run) return c.json({ error: 'run_not_found' }, 404);
  if (run.status !== 'paused') return c.json({ error: 'run_not_paused' }, 400);
  await c.env.DB.prepare('UPDATE pipeline_runs SET status = ? WHERE run_id = ?').bind('running', runId).run();
  c.executionCtx.waitUntil(executePipeline(c.env, runId, run.tenant_id, run.current_stage as Stage));
  return c.json({ run_id: runId, status: 'resumed', stage: run.current_stage });
});

// ── List runs ──
app.get('/v1/pipeline', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 50').all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Pipeline execution engine ──
async function executePipeline(env: Bindings, runId: string, tenantId: string, startFrom?: Stage) {
  const startIdx = startFrom ? STAGES.indexOf(startFrom) : 0;
  const headers = { 'X-Authority-Key': env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' };

  for (let i = startIdx; i < STAGES.length; i++) {
    const stage = STAGES[i];
    try {
      // CPR: Save checkpoint before each stage
      const checkpointId = `cp_${runId}_${stage}_${Date.now().toString(36)}`;
      await env.DB.prepare(
        'INSERT INTO cpr_checkpoints (checkpoint_id, run_id, stage, state_snapshot) VALUES (?, ?, ?, ?)'
      ).bind(checkpointId, runId, stage, JSON.stringify({ stage_index: i, tenant_id: tenantId })).run();

      // Update current stage
      await env.DB.prepare(
        'UPDATE pipeline_runs SET current_stage = ?, updated_at = datetime(\'now\') WHERE run_id = ?'
      ).bind(stage, runId).run();

      // Execute stage via service binding
      const result = await executeStage(env, stage, tenantId, runId, headers);

      // CWAR: Route based on confidence
      const confidence = result.confidence ?? 1.0;
      let decision = 'proceed';
      if (confidence < POLICY_DEFAULTS.CONFIDENCE_THRESHOLD_REJECT) {
        decision = 'reject';
        await env.DB.prepare('UPDATE pipeline_runs SET status = ?, error = ? WHERE run_id = ?')
          .bind('failed', `Stage ${stage} rejected: confidence ${confidence}`, runId).run();
        break;
      } else if (confidence < POLICY_DEFAULTS.CONFIDENCE_THRESHOLD_REVIEW) {
        decision = 'pause_for_review';
        await env.DB.prepare('UPDATE pipeline_runs SET status = ? WHERE run_id = ?').bind('paused', runId).run();
        // AGE decision
        await env.DB.prepare(
          'INSERT INTO age_decisions (decision_id, run_id, stage, action, confidence, outcome) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(`age_${runId}_${stage}`, runId, stage, 'pause_for_review', confidence, 'awaiting_operator').run();
        break;
      }

      // Record transition
      const nextStage = i + 1 < STAGES.length ? STAGES[i + 1] : 'completed';
      await env.DB.prepare(
        'INSERT INTO stage_transitions (run_id, from_stage, to_stage, confidence, decision) VALUES (?, ?, ?, ?, ?)'
      ).bind(runId, stage, nextStage, confidence, decision).run();

    } catch (err) {
      await env.DB.prepare('UPDATE pipeline_runs SET status = ?, error = ? WHERE run_id = ?')
        .bind('failed', (err as Error).message, runId).run();
      return;
    }
  }

  // Mark completed if we reached the end
  const finalRun = await env.DB.prepare('SELECT status FROM pipeline_runs WHERE run_id = ?').bind(runId).first<{ status: string }>();
  if (finalRun?.status === 'running') {
    await env.DB.prepare(
      'UPDATE pipeline_runs SET status = ?, current_stage = ?, completed_at = datetime(\'now\') WHERE run_id = ?'
    ).bind('completed', 'publish_scorecard', runId).run();
  }
}

async function executeStage(
  env: Bindings, stage: Stage, tenantId: string, runId: string, headers: Record<string, string>
): Promise<{ confidence: number; data?: unknown }> {
  switch (stage) {
    case 'ingest':
      return { confidence: 1.0 };
    case 'crawl_normalize': {
      const resp = await env.OBSERVATORY.fetch(new Request('http://internal/v1/probe', {
        method: 'POST', headers, body: JSON.stringify({ tenant_id: tenantId }),
      }));
      return { confidence: resp.ok ? 0.9 : 0.5 };
    }
    case 'examine': {
      const resp = await env.EXAMINER.fetch(new Request('http://internal/v1/examine', {
        method: 'POST', headers, body: JSON.stringify({ tenant_id: tenantId }),
      }));
      const data = resp.ok ? await resp.json() : null;
      return { confidence: resp.ok ? 0.85 : 0.4, data };
    }
    case 'evidence_graph':
      return { confidence: 0.9 };
    case 'diagnosis':
      return { confidence: 0.85 };
    case 'compile_cures': {
      const resp = await env.COMPILER.fetch(new Request('http://internal/v1/compile', {
        method: 'POST', headers, body: JSON.stringify({ tenant_id: tenantId }),
      }));
      return { confidence: resp.ok ? 0.85 : 0.5 };
    }
    case 'forge_content': {
      const resp = await env.FORGE.fetch(new Request('http://internal/v1/generate', {
        method: 'POST', headers, body: JSON.stringify({ tenant_id: tenantId }),
      }));
      return { confidence: resp.ok ? 0.8 : 0.5 };
    }
    case 'deploy_dry_run':
      return { confidence: 0.9 };
    case 'deploy':
      return { confidence: 0.85 };
    case 'remeasure': {
      const resp = await env.ENGINE.fetch(new Request('http://internal/v1/tenants/' + tenantId + '/compute-aii', {
        method: 'POST', headers,
      }));
      return { confidence: resp.ok ? 0.9 : 0.5 };
    }
    case 'compare_deltas':
      return { confidence: 0.9 };
    case 'publish_scorecard':
      return { confidence: 1.0 };
    default:
      return { confidence: 0 };
  }
}

export default app;
