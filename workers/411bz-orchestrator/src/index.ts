/**
 * 411bz-orchestrator — 12-stage state machine.
 * CPR: Checkpoint/Pause/Resume
 * CWAR: Confidence-Weighted Action Routing
 * AGE: Authority Governance Engine
 *
 * Every stage executor calls a real service endpoint via service binding.
 * No stage returns a hardcoded confidence — all confidence values come from
 * downstream service responses or are computed from result data.
 */

import { Hono } from 'hono';
import { assertTenantId, wrapTruth, generateRequestId } from 'shared-authority-core';
import { STAGES, executePipeline, type Bindings, type Stage } from './pipeline.js';

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
  const cwarDecisions = await c.env.DB.prepare(
    'SELECT * FROM cwar_decisions WHERE run_id = ? ORDER BY decided_at'
  ).bind(runId).all();
  const ageDecisions = await c.env.DB.prepare(
    'SELECT * FROM age_decisions WHERE run_id = ? ORDER BY decided_at'
  ).bind(runId).all();
  // Fabric slips sit beside the stage-level CWAR rows; empty until the Fabric schema is applied.
  const fabricSlips = await c.env.DB.prepare(
    'SELECT * FROM fabric_slips WHERE run_id = ? ORDER BY decided_at'
  ).bind(runId).all().catch(() => ({ results: [] }));
  return c.json(wrapTruth(
    { run, transitions: transitions.results, cwar: cwarDecisions.results, age: ageDecisions.results, fabric: fabricSlips.results },
    c.env.WORKER_ID, generateRequestId()
  ));
});

// ── Resume from checkpoint (CPR) ──
app.post('/v1/pipeline/:run_id/resume', async (c) => {
  const runId = c.req.param('run_id');
  const run = await c.env.DB.prepare('SELECT * FROM pipeline_runs WHERE run_id = ?').bind(runId).first<{
    run_id: string; tenant_id: string; current_stage: string; status: string;
  }>();
  if (!run) return c.json({ error: 'run_not_found' }, 404);
  if (run.status !== 'paused') return c.json({ error: 'run_not_paused' }, 400);
  await c.env.DB.prepare('UPDATE pipeline_runs SET status = ? WHERE run_id = ?').bind('running', runId).run();
  c.executionCtx.waitUntil(executePipeline(c.env, runId, run.tenant_id, run.current_stage as Stage));
  return c.json({ run_id: runId, status: 'resumed', stage: run.current_stage });
});

// ── List runs ──
app.get('/v1/pipeline', async (c) => {
  const tenantId = c.req.query('tenant_id');
  const query = tenantId
    ? c.env.DB.prepare('SELECT * FROM pipeline_runs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT 50').bind(tenantId)
    : c.env.DB.prepare('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 50');
  const rows = await query.all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

export default app;
