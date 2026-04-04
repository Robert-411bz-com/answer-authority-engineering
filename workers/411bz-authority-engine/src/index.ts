/**
 * 411bz-authority-engine — Core platform worker.
 * Hono router, 24 D1 tables, AII computation, connectors, evidence management.
 */

import { Hono } from 'hono';
import {
  assertTenantId, computeContentHash, enforceProofGate, createArtifactId,
  wrapTruth, generateRequestId, TenantPolicy,
  computeAII, getDefaultWeights, type ScoreInput,
  POLICY_DEFAULTS, CANONICAL_WORKERS,
} from 'shared-authority-core';
import { computeFullAII, normalizeScore } from './computation.js';

type Bindings = {
  DB: D1Database;
  ARTIFACTS_BUCKET: R2Bucket;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// ── Auth middleware ──
app.use('/v1/*', async (c, next) => {
  const key = c.req.header('X-Authority-Key');
  if (key !== c.env.AUTHORITY_INTERNAL_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

// ── Health ──
app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

// ── Tenants ──
app.get('/v1/tenants', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

app.get('/v1/tenants/:tenant_id', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const row = await c.env.DB.prepare('SELECT * FROM tenants WHERE tenant_id = ?').bind(tid).first();
  if (!row) return c.json({ error: 'tenant_not_found' }, 404);
  return c.json(wrapTruth(row, c.env.WORKER_ID, generateRequestId()));
});

app.post('/v1/tenants', async (c) => {
  const body = await c.req.json<{ tenant_id: string; domain: string; business_name: string; business_type?: string; plan?: string }>();
  assertTenantId(body.tenant_id);
  await c.env.DB.prepare(
    'INSERT INTO tenants (tenant_id, domain, business_name, business_type, plan) VALUES (?, ?, ?, ?, ?)'
  ).bind(body.tenant_id, body.domain, body.business_name, body.business_type || 'Organization', body.plan || 'trial').run();
  return c.json({ created: body.tenant_id }, 201);
});

// ── Scores & AII ──
app.get('/v1/tenants/:tenant_id/scores', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM scores WHERE tenant_id = ? ORDER BY computed_at DESC').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

app.post('/v1/tenants/:tenant_id/compute-aii', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const result = await computeFullAII(c.env.DB, tid);
  return c.json(wrapTruth(result, c.env.WORKER_ID, generateRequestId()));
});

// ── Evidence ──
app.get('/v1/tenants/:tenant_id/evidence', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM evidence WHERE tenant_id = ? ORDER BY extracted_at DESC').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

app.post('/v1/tenants/:tenant_id/evidence', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const body = await c.req.json<{ source_type: string; source_url: string; content: string; confidence: number }>();
  const hash = await computeContentHash(body.content);
  const eid = `ev_${body.source_type}_${tid.substring(0, 8)}_${Date.now().toString(36)}`;
  await c.env.DB.prepare(
    'INSERT INTO evidence (evidence_id, tenant_id, source_type, source_url, content_hash, confidence) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(eid, tid, body.source_type, body.source_url, hash, body.confidence).run();
  return c.json({ evidence_id: eid, content_hash: hash }, 201);
});

// ── Claims ──
app.get('/v1/tenants/:tenant_id/claims', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM claims WHERE tenant_id = ?').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Diagnoses ──
app.get('/v1/tenants/:tenant_id/diagnoses', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM diagnoses WHERE tenant_id = ? ORDER BY created_at DESC').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Cures ──
app.get('/v1/tenants/:tenant_id/cures', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM cures WHERE tenant_id = ? ORDER BY priority DESC').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Artifacts ──
app.get('/v1/tenants/:tenant_id/artifacts', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM artifacts WHERE tenant_id = ? ORDER BY created_at DESC').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Connectors ──
app.get('/v1/tenants/:tenant_id/connectors', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM connectors WHERE tenant_id = ?').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

app.post('/v1/tenants/:tenant_id/connectors', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const body = await c.req.json<{ connector_type: string; config: Record<string, unknown> }>();
  const cid = `conn_${body.connector_type}_${tid.substring(0, 8)}_${Date.now().toString(36)}`;
  await c.env.DB.prepare(
    'INSERT INTO connectors (connector_id, tenant_id, connector_type, config) VALUES (?, ?, ?, ?)'
  ).bind(cid, tid, body.connector_type, JSON.stringify(body.config)).run();
  return c.json({ connector_id: cid }, 201);
});

// ── Categories ──
app.get('/v1/categories', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM categories ORDER BY name').all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Competitive ──
app.get('/v1/tenants/:tenant_id/competitive', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM competitive_profiles WHERE tenant_id = ?').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Visibility ──
app.get('/v1/tenants/:tenant_id/visibility', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM visibility_snapshots WHERE tenant_id = ? ORDER BY snapshot_at DESC LIMIT 100').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Audit log ──
app.get('/v1/audit-log', async (c) => {
  const limit = parseInt(c.req.query('limit') || '100');
  const rows = await c.env.DB.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Affiliates ──
app.get('/v1/affiliates', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM affiliates ORDER BY created_at DESC').all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Promo codes ──
app.get('/v1/promo-codes', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM promo_codes WHERE active = 1').all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Deployments ──
app.get('/v1/tenants/:tenant_id/deployments', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM deployments WHERE tenant_id = ? ORDER BY deployed_at DESC').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Score history ──
app.get('/v1/tenants/:tenant_id/score-history', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM score_history WHERE tenant_id = ? ORDER BY computed_at DESC LIMIT 200').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

export default app;
