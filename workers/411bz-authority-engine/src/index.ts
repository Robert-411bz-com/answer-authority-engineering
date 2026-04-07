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
  try {
    const body = await c.req.json<{ tenant_id: string; domain: string; business_name: string; business_type?: string; plan?: string }>();
    assertTenantId(body.tenant_id);
    await c.env.DB.prepare(
      'INSERT INTO tenants (tenant_id, domain, business_name, business_type, plan) VALUES (?, ?, ?, ?, ?)'
    ).bind(body.tenant_id, body.domain, body.business_name, body.business_type || 'Organization', body.plan || 'trial').run();
    return c.json(
      wrapTruth({ tenant_id: body.tenant_id, domain: body.domain, created: true }, c.env.WORKER_ID, generateRequestId()),
      201
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint|SQLITE_CONSTRAINT|constraint/i.test(msg)) {
      const conflict = /domain/i.test(msg) ? 'domain' : 'tenant_id';
      return c.json(
        { error: 'tenant_conflict', conflict, detail: `A tenant with this ${conflict} already exists` },
        409
      );
    }
    console.error('POST /v1/tenants error:', msg);
    return c.json({ error: 'insert_failed', detail: msg }, 500);
  }
});

// ── Subscriptions (D1; proxied by frontend as POST /api/v1/subscriptions) ──
app.get('/v1/subscriptions/:tenant_id', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const row = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE tenant_id = ?').bind(tid).first();
  if (!row) return c.json({ error: 'subscription_not_found' }, 404);
  return c.json(wrapTruth(row, c.env.WORKER_ID, generateRequestId()));
});

app.post('/v1/subscriptions', async (c) => {
  try {
    const body = await c.req.json<{
      tenant_id: string;
      plan: string;
      status?: string;
      current_period_end?: string;
      stripe_subscription_id?: string;
      stripe_customer_id?: string;
    }>();
    assertTenantId(body.tenant_id);
    const tid = body.tenant_id;
    const existingTenant = await c.env.DB.prepare('SELECT tenant_id FROM tenants WHERE tenant_id = ?').bind(tid).first();
    if (!existingTenant) {
      return c.json({ error: 'tenant_not_found' }, 404);
    }
    const rowId = `sub_${tid}`;
    const plan = body.plan;
    const status = body.status ?? 'active';
    const stripeSub = body.stripe_subscription_id ?? null;
    const stripeCust = body.stripe_customer_id ?? null;
    const periodEnd = body.current_period_end ?? null;

    await c.env.DB.prepare(
      `INSERT INTO subscriptions (id, tenant_id, plan, stripe_subscription_id, stripe_customer_id, status, current_period_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(tenant_id) DO UPDATE SET
         plan = excluded.plan,
         stripe_subscription_id = excluded.stripe_subscription_id,
         stripe_customer_id = excluded.stripe_customer_id,
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         updated_at = datetime('now')`
    ).bind(rowId, tid, plan, stripeSub, stripeCust, status, periodEnd).run();

    return c.json(
      wrapTruth(
        {
          tenant_id: tid,
          plan,
          status,
          current_period_end: periodEnd,
          stripe_subscription_id: stripeSub,
          stripe_customer_id: stripeCust,
        },
        c.env.WORKER_ID,
        generateRequestId()
      ),
      201
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('POST /v1/subscriptions error:', msg);
    return c.json({ error: 'subscription_upsert_failed', detail: msg }, 500);
  }
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
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const rows = await c.env.DB.prepare(
    'SELECT * FROM evidence WHERE tenant_id = ? ORDER BY extracted_at DESC LIMIT ? OFFSET ?'
  ).bind(tid, limit, offset).all();
  const countRow = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM evidence WHERE tenant_id = ?'
  ).bind(tid).first<{ total: number }>();
  return c.json(wrapTruth(
    { items: rows.results, total: countRow?.total || 0, limit, offset },
    c.env.WORKER_ID, generateRequestId()
  ));
});

// Also support the flat path the orchestrator/examiner may use
app.get('/v1/evidence/:tenant_id', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const rows = await c.env.DB.prepare(
    'SELECT * FROM evidence WHERE tenant_id = ? ORDER BY extracted_at DESC LIMIT ? OFFSET ?'
  ).bind(tid, limit, offset).all();
  const countRow = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM evidence WHERE tenant_id = ?'
  ).bind(tid).first<{ total: number }>();
  return c.json(wrapTruth(
    { items: rows.results, total: countRow?.total || 0, limit, offset },
    c.env.WORKER_ID, generateRequestId()
  ));
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
  await logAudit(c.env.DB, tid, 'system', 'evidence_created', 'evidence', eid);
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

// Batch persist diagnoses from examiner
app.post('/v1/tenants/:tenant_id/diagnoses/batch', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const body = await c.req.json<{
    diagnoses: Array<{
      diagnosis_id: string; category: string; severity: string;
      description: string; evidence_ids: string[];
    }>;
  }>();
  let persisted = 0;
  for (const d of body.diagnoses) {
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO diagnoses (diagnosis_id, tenant_id, category, severity, description, evidence_ids) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(d.diagnosis_id, tid, d.category, d.severity, d.description, JSON.stringify(d.evidence_ids)).run();
    persisted++;
  }
  await logAudit(c.env.DB, tid, 'system', 'diagnoses_batch_created', 'diagnoses', `count:${persisted}`);
  return c.json({ persisted, tenant_id: tid }, 201);
});

// ── Cures ──
app.get('/v1/tenants/:tenant_id/cures', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM cures WHERE tenant_id = ? ORDER BY priority DESC').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// Batch persist cures from solution compiler
app.post('/v1/tenants/:tenant_id/cures/batch', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const body = await c.req.json<{
    cures: Array<{
      cure_id: string; diagnosis_id: string; category: string;
      action_type: string; target: string; instructions: string;
      evidence_ids: string[]; priority: number; estimated_impact: number;
      confidence: number; status: string;
    }>;
  }>();
  let persisted = 0;
  for (const cure of body.cures) {
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO cures (cure_id, tenant_id, diagnosis_id, category, action_type, target, instructions, evidence_ids, priority, estimated_impact, confidence, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      cure.cure_id, tid, cure.diagnosis_id, cure.category,
      cure.action_type, cure.target, cure.instructions,
      JSON.stringify(cure.evidence_ids), cure.priority,
      cure.estimated_impact, cure.confidence, cure.status || 'pending'
    ).run();
    persisted++;
  }
  await logAudit(c.env.DB, tid, 'system', 'cures_batch_created', 'cures', `count:${persisted}`);
  return c.json({ persisted, tenant_id: tid }, 201);
});

// ── Artifacts ──
app.get('/v1/tenants/:tenant_id/artifacts', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM artifacts WHERE tenant_id = ? ORDER BY created_at DESC').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// Persist artifact from forge or other producers
app.post('/v1/tenants/:tenant_id/artifacts', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const body = await c.req.json<{
    artifact_id: string; kind: string; content: string;
    content_hash: string; cure_refs?: string[]; version?: number; metadata?: Record<string, unknown>;
  }>();
  const gate = enforceProofGate({
    artifact_id: body.artifact_id,
    tenant_id: tid,
    kind: body.kind as import('shared-authority-core').ArtifactKind,
    content: body.content,
    content_hash: body.content_hash,
    cure_refs: body.cure_refs || [],
    created_at: new Date().toISOString(),
    version: body.version || 1,
    metadata: body.metadata || {},
  });
  if (!gate.passed) {
    return c.json({ error: 'proof_gate_failed', violations: gate.violations }, 422);
  }
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO artifacts (artifact_id, tenant_id, kind, content, content_hash, cure_refs, version, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    body.artifact_id, tid, body.kind, body.content, body.content_hash,
    JSON.stringify(body.cure_refs || []), body.version || 1,
    JSON.stringify(body.metadata || {})
  ).run();
  await logAudit(c.env.DB, tid, 'system', 'artifact_created', 'artifact', body.artifact_id);
  return c.json({ artifact_id: body.artifact_id, content_hash: body.content_hash }, 201);
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

// ── Connector ingest (called by orchestrator ingest stage) ──
app.post('/v1/connectors/ingest', async (c) => {
  const body = await c.req.json<{ tenant_id: string }>();
  assertTenantId(body.tenant_id);
  const connectors = await c.env.DB.prepare(
    'SELECT * FROM connectors WHERE tenant_id = ? AND status = ?'
  ).bind(body.tenant_id, 'active').all();
  const { runConnector } = await import('./connectors/index.js');
  const results = [];
  for (const conn of connectors.results) {
    const config = { connector_type: conn.connector_type as string, config: JSON.parse(conn.config as string) };
    const result = await runConnector(c.env.DB, body.tenant_id, config);
    results.push({ connector_type: conn.connector_type, ...result });
  }
  await logAudit(c.env.DB, body.tenant_id, 'system', 'connectors_ingested', 'connectors', `count:${results.length}`);
  return c.json(wrapTruth({ tenant_id: body.tenant_id, connector_results: results }, c.env.WORKER_ID, generateRequestId()));
});

// ── Scorecard publish (called by orchestrator publish_scorecard stage) ──
app.post('/v1/scorecard/publish', async (c) => {
  const body = await c.req.json<{
    tenant_id: string;
    run_id?: string;
    aii_before?: number;
    aii_after?: number;
    factor_scores?: Record<string, number>;
  }>();
  assertTenantId(body.tenant_id);

  // Compute current AII
  const aiiResult = await computeFullAII(c.env.DB, body.tenant_id);
  const aiiAfter = body.aii_after ?? aiiResult.aii;
  const aiiBefore = body.aii_before ?? 0;
  const delta = Math.round((aiiAfter - aiiBefore) * 1000) / 1000;

  const scorecardPayload = {
    tenant_id: body.tenant_id,
    run_id: body.run_id || null,
    aii_before: aiiBefore,
    aii_after: aiiAfter,
    delta,
    factor_scores: body.factor_scores || aiiResult.dimensions,
    provenance: aiiResult.provenance,
    published_at: new Date().toISOString(),
  };

  const scorecardJson = JSON.stringify(scorecardPayload);
  const contentHash = await computeContentHash(scorecardJson);
  const scorecardId = `sc_${body.tenant_id.substring(0, 8)}_${Date.now().toString(36)}`;

  // Store as a score record with provenance
  await c.env.DB.prepare(
    'INSERT INTO scores (score_id, tenant_id, score_type, score_value, provenance) VALUES (?, ?, ?, ?, ?)'
  ).bind(scorecardId, body.tenant_id, 'scorecard', aiiAfter, scorecardJson).run();

  await logAudit(c.env.DB, body.tenant_id, 'system', 'scorecard_published', 'scorecard', scorecardId);

  return c.json(wrapTruth(
    { scorecard_id: scorecardId, content_hash: contentHash, ...scorecardPayload },
    c.env.WORKER_ID, generateRequestId()
  ), 201);
});

// ── Deployments ──
app.get('/v1/tenants/:tenant_id/deployments', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM deployments WHERE tenant_id = ? ORDER BY deployed_at DESC').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// Record a deployment (called by observatory after deploy)
app.post('/v1/tenants/:tenant_id/deployments', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const body = await c.req.json<{
    deployment_id: string; artifact_ids: string[];
    verdict: string; deployed_by?: string;
  }>();
  await c.env.DB.prepare(
    'INSERT INTO deployments (deployment_id, tenant_id, artifact_ids, verdict, deployed_by) VALUES (?, ?, ?, ?, ?)'
  ).bind(body.deployment_id, tid, JSON.stringify(body.artifact_ids), body.verdict, body.deployed_by || 'system').run();
  await logAudit(c.env.DB, tid, body.deployed_by || 'system', 'deployment_created', 'deployment', body.deployment_id);
  return c.json({ deployment_id: body.deployment_id }, 201);
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
  const tenantFilter = c.req.query('tenant_id');
  if (tenantFilter) {
    assertTenantId(tenantFilter);
    const rows = await c.env.DB.prepare(
      'SELECT * FROM affiliates WHERE tenant_id = ? ORDER BY created_at DESC'
    ).bind(tenantFilter).all();
    return c.json(wrapTruth(rows.results ?? [], c.env.WORKER_ID, generateRequestId()));
  }
  const rows = await c.env.DB.prepare('SELECT * FROM affiliates ORDER BY created_at DESC').all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Promo codes ──
app.get('/v1/promo-codes', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM promo_codes WHERE active = 1').all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Score history ──
app.get('/v1/tenants/:tenant_id/score-history', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare('SELECT * FROM score_history WHERE tenant_id = ? ORDER BY computed_at DESC LIMIT 200').bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Scorecards (global list — operator / E2E; prefer per-tenant route below for scoping) ──
app.get('/v1/scorecards', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM scores WHERE score_type = 'scorecard' ORDER BY computed_at DESC LIMIT 100"
  ).all();
  return c.json(wrapTruth(rows.results ?? [], c.env.WORKER_ID, generateRequestId()));
});

// ── Scorecards (query published scorecards) ──
app.get('/v1/tenants/:tenant_id/scorecards', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM scores WHERE tenant_id = ? AND score_type = 'scorecard' ORDER BY computed_at DESC"
  ).bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Subscriptions (called by 411bz-stripe webhook handlers) ──

app.get('/v1/subscriptions/:tenant_id', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const row = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE tenant_id = ?').bind(tid).first();
  if (!row) return c.json({ error: 'subscription_not_found' }, 404);
  return c.json(wrapTruth(row, c.env.WORKER_ID, generateRequestId()));
});

app.post('/v1/subscriptions', async (c) => {
  const body = await c.req.json<{
    tenant_id: string;
    plan: string;
    stripe_subscription_id?: string;
    stripe_customer_id?: string;
    status?: string;
    current_period_end?: string | null;
    max_domains?: number;
  }>();
  assertTenantId(body.tenant_id);

  const maxDomains =
    body.max_domains ?? (body.plan === 'pro' ? 10 : body.plan === 'growth' ? 5 : 1);

  await c.env.DB
    .prepare(
      `
    INSERT INTO subscriptions (id, tenant_id, plan, stripe_subscription_id, stripe_customer_id, status, current_period_end, max_domains, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id) DO UPDATE SET
      plan = excluded.plan,
      stripe_subscription_id = excluded.stripe_subscription_id,
      stripe_customer_id = excluded.stripe_customer_id,
      status = excluded.status,
      current_period_end = excluded.current_period_end,
      max_domains = excluded.max_domains,
      updated_at = datetime('now')
  `,
    )
    .bind(
      `sub_${body.tenant_id}_${Date.now().toString(36)}`,
      body.tenant_id,
      body.plan,
      body.stripe_subscription_id || null,
      body.stripe_customer_id || null,
      body.status || 'active',
      body.current_period_end || null,
      maxDomains,
    )
    .run();

  await logAudit(
    c.env.DB,
    body.tenant_id,
    'stripe',
    'subscription_upserted',
    'subscription',
    body.stripe_subscription_id || body.tenant_id,
  );
  return c.json(
    wrapTruth(
      { tenant_id: body.tenant_id, plan: body.plan, status: body.status || 'active' },
      c.env.WORKER_ID,
      generateRequestId(),
    ),
    200,
  );
});

app.post('/v1/tenants/:tenant_id/plan', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const body = await c.req.json<{ plan: string }>();
  const validPlans = ['trial', 'starter', 'growth', 'pro'];
  if (!validPlans.includes(body.plan)) {
    return c.json({ error: 'invalid_plan', detail: `Must be one of: ${validPlans.join(', ')}` }, 400);
  }
  await c.env.DB
    .prepare("UPDATE tenants SET plan = ?, updated_at = datetime('now') WHERE tenant_id = ?")
    .bind(body.plan, tid)
    .run();
  await logAudit(c.env.DB, tid, 'stripe', 'plan_updated', 'tenant', body.plan);
  return c.json(wrapTruth({ tenant_id: tid, plan: body.plan }, c.env.WORKER_ID, generateRequestId()));
});

app.post('/v1/commissions', async (c) => {
  const body = await c.req.json<{
    affiliate_id: string;
    tenant_id: string;
    invoice_id: string;
    amount_cents: number;
    commission_cents: number;
    commission_rate: number;
  }>();
  const commId = `comm_${body.tenant_id.substring(0, 8)}_${Date.now().toString(36)}`;
  try {
    await c.env.DB
      .prepare(
        'INSERT INTO commissions (commission_id, affiliate_id, tenant_id, invoice_id, amount_cents, commission_cents, commission_rate) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        commId,
        body.affiliate_id,
        body.tenant_id,
        body.invoice_id,
        body.amount_cents,
        body.commission_cents,
        body.commission_rate,
      )
      .run();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Commission persist error:', msg);
    return c.json({ error: 'commission_failed', detail: msg }, 500);
  }
  await logAudit(c.env.DB, body.tenant_id, 'stripe', 'commission_created', 'commission', commId);
  return c.json({ commission_id: commId }, 201);
});

app.get('/v1/plan-features/:plan', async (c) => {
  const plan = c.req.param('plan');
  const rows = await c.env.DB.prepare('SELECT feature FROM plan_features WHERE plan = ?').bind(plan).all();
  return c.json(
    wrapTruth(
      { plan, features: rows.results.map((r) => r.feature as string) },
      c.env.WORKER_ID,
      generateRequestId(),
    ),
  );
});

// ── Audit log helper ──
async function logAudit(
  db: D1Database, tenantId: string | null, actor: string,
  action: string, resourceType?: string, resourceId?: string
): Promise<void> {
  await db.prepare(
    'INSERT INTO audit_log (tenant_id, actor, action, resource_type, resource_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(tenantId, actor, action, resourceType || null, resourceId || null).run();
}

export default app;
