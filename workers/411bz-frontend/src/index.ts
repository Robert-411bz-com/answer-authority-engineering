/**
 * 411bz-frontend — User-facing API gateway.
 * No hardcoded worker.dev URLs — all calls via service bindings.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { wrapTruth, generateRequestId, CANONICAL_WORKERS } from 'shared-authority-core';

type Bindings = {
  ENGINE: Fetcher;
  ORCHESTRATOR: Fetcher;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE'] }));

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

// Proxy to engine
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

// Pipeline endpoints
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

export default app;
