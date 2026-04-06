/**
 * 411bz-dashboard — Client-facing dashboard.
 * Comprehensive view: tenants, scores, affiliates, pipeline status.
 */

import { Hono } from 'hono';
import { wrapTruth, generateRequestId, CANONICAL_WORKERS } from 'shared-authority-core';

type Bindings = {
  ENGINE: Fetcher;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

app.get('/v1/overview/:tenant_id', async (c) => {
  const tid = c.req.param('tenant_id');
  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY };

  const [tenantResp, scoresResp, curesResp, artifactsResp] = await Promise.all([
    c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${tid}`, { headers })),
    c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${tid}/scores`, { headers })),
    c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${tid}/cures`, { headers })),
    c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${tid}/artifacts`, { headers })),
  ]);

  const tenant = tenantResp.ok ? await tenantResp.json() : null;
  const scores = scoresResp.ok ? await scoresResp.json() : { data: [] };
  const cures = curesResp.ok ? await curesResp.json() : { data: [] };
  const artifacts = artifactsResp.ok ? await artifactsResp.json() : { data: [] };

  return c.json(wrapTruth({ tenant, scores, cures, artifacts }, c.env.WORKER_ID, generateRequestId()));
});

export default app;
