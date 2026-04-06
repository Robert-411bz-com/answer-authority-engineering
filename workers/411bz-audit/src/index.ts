/**
 * 411bz-audit — Cron-based platform audit worker.
 * Runs every 6 hours to verify platform integrity.
 */

import { Hono } from 'hono';
import { CANONICAL_WORKERS, wrapTruth, generateRequestId } from 'shared-authority-core';

type Bindings = {
  ENGINE: Fetcher;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

app.get('/v1/run-audit', async (c) => {
  const key = c.req.header('X-Authority-Key');
  if (key !== c.env.AUTHORITY_INTERNAL_KEY) return c.json({ error: 'unauthorized' }, 401);
  const result = await runAudit(c.env);
  return c.json(wrapTruth(result, c.env.WORKER_ID, generateRequestId()));
});

async function runAudit(env: Bindings) {
  const headers = { 'X-Authority-Key': env.AUTHORITY_INTERNAL_KEY };
  const checks: Array<{ name: string; passed: boolean; details?: string }> = [];

  // Check engine health
  try {
    const resp = await env.ENGINE.fetch(new Request('http://internal/health', { headers }));
    checks.push({ name: 'engine_health', passed: resp.ok });
  } catch (e) {
    checks.push({ name: 'engine_health', passed: false, details: (e as Error).message });
  }

  // Check tenants exist
  try {
    const resp = await env.ENGINE.fetch(new Request('http://internal/v1/tenants', { headers }));
    const data = resp.ok ? await resp.json() as { data: unknown[] } : { data: [] };
    checks.push({ name: 'tenants_exist', passed: (data.data || []).length > 0, details: `${(data.data || []).length} tenants` });
  } catch (e) {
    checks.push({ name: 'tenants_exist', passed: false, details: (e as Error).message });
  }

  return { audit_at: new Date().toISOString(), checks, all_passed: checks.every(c => c.passed) };
}

// Cron handler
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runAudit(env));
  },
};
