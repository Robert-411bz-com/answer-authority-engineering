/**
 * 411bz-frontend — User-facing API gateway.
 * No hardcoded worker.dev URLs — all calls via service bindings.
 * Runtime config endpoint exposes safe platform metadata to clients.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  wrapTruth, generateRequestId, CANONICAL_WORKERS,
  POLICY_DEFAULTS,
} from 'shared-authority-core';

type Bindings = {
  ENGINE: Fetcher;
  ORCHESTRATOR: Fetcher;
  OBSERVATORY: Fetcher;
  BOSS_AI: Fetcher;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
  FRONTEND_HOST: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE'] }));

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

/**
 * GET /api/runtime-config — Safe platform metadata for client apps.
 * No secrets, no internal URLs — only public-facing configuration.
 */
app.get('/api/runtime-config', (c) => {
  return c.json(wrapTruth({
    platform: '411bz.ai',
    version: '2.0.0',
    host: c.env.FRONTEND_HOST || c.req.header('host') || 'api.411bz.ai',
    features: {
      orchestrator_stages: POLICY_DEFAULTS.ORCHESTRATOR_STAGE_COUNT,
      examiner_categories: POLICY_DEFAULTS.EXAMINER_CATEGORY_COUNT,
      max_overlays: POLICY_DEFAULTS.MAX_OVERLAYS,
      promo_free30_days: POLICY_DEFAULTS.PROMO_FREE30_DAYS,
      promo_free90_days: POLICY_DEFAULTS.PROMO_FREE90_DAYS,
    },
    workers: Object.values(CANONICAL_WORKERS),
    endpoints: {
      tenants: '/api/v1/tenants',
      pipeline_start: '/api/pipeline/start',
      pipeline_status: '/api/pipeline/:run_id',
      scorecards: '/api/v1/scorecards',
      evidence: '/api/v1/evidence/:tenant_id',
    },
  }, c.env.WORKER_ID, generateRequestId()));
});

// ── Proxy to engine (all /api/v1/* routes) ──
app.all('/api/v1/*', async (c) => {
  const path = c.req.path.replace('/api', '');
  const headers: Record<string, string> = {
    'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY,
    'Content-Type': c.req.header('Content-Type') || 'application/json',
  };
  const init: RequestInit = { method: c.req.method, headers };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = await c.req.text();
  }
  const resp = await c.env.ENGINE.fetch(new Request(`http://internal${path}`, init));
  return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
});

// ── Pipeline endpoints ──
app.post('/api/pipeline/start', async (c) => {
  const body = await c.req.text();
  const resp = await c.env.ORCHESTRATOR.fetch(new Request('http://internal/v1/pipeline/start', {
    method: 'POST',
    headers: { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' },
    body,
  }));
  return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
});

app.get('/api/pipeline/:run_id', async (c) => {
  const runId = c.req.param('run_id');
  const resp = await c.env.ORCHESTRATOR.fetch(new Request(`http://internal/v1/pipeline/${runId}`, {
    headers: { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY },
  }));
  return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
});

// ── Pipeline list ──
app.get('/api/pipeline', async (c) => {
  const tenantId = c.req.query('tenant_id');
  const url = tenantId ? `http://internal/v1/pipeline?tenant_id=${tenantId}` : 'http://internal/v1/pipeline';
  const resp = await c.env.ORCHESTRATOR.fetch(new Request(url, {
    headers: { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY },
  }));
  return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
});

export default app;
