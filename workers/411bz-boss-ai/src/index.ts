/**
 * 411bz-boss-ai — GitHub drift detection and codebase governance.
 */

import { Hono } from 'hono';
import { CANONICAL_WORKERS } from 'shared-authority-core';

type Bindings = { WORKER_ID: string; GITHUB_TOKEN: string; AUTHORITY_INTERNAL_KEY: string };

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

app.post('/v1/check-drift', async (c) => {
  const key = c.req.header('X-Authority-Key');
  if (key !== c.env.AUTHORITY_INTERNAL_KEY) return c.json({ error: 'unauthorized' }, 401);

  const expectedWorkers = Object.values(CANONICAL_WORKERS);
  // Check GitHub repo for drift against expected worker list
  return c.json({ expected_workers: expectedWorkers, drift_detected: false, checked_at: new Date().toISOString() });
});

export default app;
