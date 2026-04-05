/**
 * 411bz-frontend — User-facing API gateway.
 *
 * CRITICAL FIX (April 5 audit §7.1): All proxy handlers now materialize
 * upstream responses with `await resp.text()` instead of passing
 * `resp.body` (ReadableStream). Cloudflare service-binding responses
 * can silently fail when a ReadableStream body is forwarded directly.
 *
 * Auth: Prefer incoming X-Authority-Key header; fall back to
 * AUTHORITY_INTERNAL_KEY env only when the header is absent.
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

// ── Helpers ──

/** Resolve the authority key: prefer caller-supplied header, fall back to env. */
function authorityKey(c: any): string {
  return c.req.header('X-Authority-Key') || c.env.AUTHORITY_INTERNAL_KEY;
}

/** Safely proxy a service-binding call, materializing the body and wrapping errors. */
async function safeProxy(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  workerId: string,
): Promise<Response> {
  try {
    const upstream = await fetcher.fetch(new Request(url, init));
    const body = await upstream.text();          // ← materialize, never pass ReadableStream
    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    const reqId = generateRequestId();
    const envelope = wrapTruth(
      { error: 'proxy_error', detail: err?.message || 'upstream unreachable' },
      workerId,
      reqId,
    );
    return new Response(JSON.stringify(envelope), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ── Health ──

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

// ── Runtime Config ──

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

// ── Proxy to ENGINE (all /api/v1/* routes) ──

app.all('/api/v1/*', async (c) => {
  const path = c.req.path.replace('/api', '');
  const headers: Record<string, string> = {
    'X-Authority-Key': authorityKey(c),
    'Content-Type': c.req.header('Content-Type') || 'application/json',
  };
  const init: RequestInit = { method: c.req.method, headers };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = await c.req.text();
  }
  return safeProxy(c.env.ENGINE, `http://internal${path}`, init, c.env.WORKER_ID);
});

// ── Pipeline: start ──

app.post('/api/pipeline/start', async (c) => {
  const body = await c.req.text();
  return safeProxy(
    c.env.ORCHESTRATOR,
    'http://internal/v1/pipeline/start',
    {
      method: 'POST',
      headers: {
        'X-Authority-Key': authorityKey(c),
        'Content-Type': 'application/json',
      },
      body,
    },
    c.env.WORKER_ID,
  );
});

// ── Pipeline: status by run_id ──

app.get('/api/pipeline/:run_id', async (c) => {
  const runId = c.req.param('run_id');
  return safeProxy(
    c.env.ORCHESTRATOR,
    `http://internal/v1/pipeline/${runId}`,
    { headers: { 'X-Authority-Key': authorityKey(c) } },
    c.env.WORKER_ID,
  );
});

// ── Pipeline: list ──

app.get('/api/pipeline', async (c) => {
  const tenantId = c.req.query('tenant_id');
  const url = tenantId
    ? `http://internal/v1/pipeline?tenant_id=${tenantId}`
    : 'http://internal/v1/pipeline';
  return safeProxy(
    c.env.ORCHESTRATOR,
    url,
    { headers: { 'X-Authority-Key': authorityKey(c) } },
    c.env.WORKER_ID,
  );
});

export default app;
