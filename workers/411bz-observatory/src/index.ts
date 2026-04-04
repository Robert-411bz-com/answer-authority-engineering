/**
 * 411bz-observatory — Domain probing engine.
 * Probes tenant domains for technical signals, schema, llms.txt, etc.
 */

import { Hono } from 'hono';
import { assertTenantId, wrapTruth, generateRequestId, POLICY_DEFAULTS, CANONICAL_WORKERS } from 'shared-authority-core';

type Bindings = {
  ENGINE: Fetcher;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('/v1/*', async (c, next) => {
  const key = c.req.header('X-Authority-Key');
  if (key !== c.env.AUTHORITY_INTERNAL_KEY) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

app.post('/v1/probe', async (c) => {
  const body = await c.req.json<{ tenant_id: string; domain?: string }>();
  assertTenantId(body.tenant_id);

  // Get tenant domain from engine if not provided
  let domain = body.domain;
  if (!domain) {
    const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY };
    const resp = await c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}`, { headers }));
    if (resp.ok) {
      const data = await resp.json() as { data: { domain: string } };
      domain = data.data?.domain;
    }
  }
  if (!domain) return c.json({ error: 'no_domain' }, 400);

  const probes = await Promise.allSettled([
    probeUrl(`https://${domain}`, 'homepage'),
    probeUrl(`https://${domain}/robots.txt`, 'robots'),
    probeUrl(`https://${domain}/sitemap.xml`, 'sitemap'),
    probeUrl(`https://${domain}/llms.txt`, 'llms_txt'),
    probeUrl(`https://${domain}/.well-known/schema.json`, 'schema'),
  ]);

  const results = probes.map((p, i) => {
    const labels = ['homepage', 'robots', 'sitemap', 'llms_txt', 'schema'];
    if (p.status === 'fulfilled') return { probe: labels[i], ...p.value };
    return { probe: labels[i], status: 0, latency_ms: 0, error: (p.reason as Error).message };
  });

  return c.json(wrapTruth({ tenant_id: body.tenant_id, domain, probes: results }, c.env.WORKER_ID, generateRequestId()));
});

async function probeUrl(url: string, type: string): Promise<{ status: number; latency_ms: number; has_content: boolean }> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POLICY_DEFAULTS.PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const latency = Date.now() - start;
    const text = await resp.text();
    return { status: resp.status, latency_ms: latency, has_content: text.length > 0 };
  } finally {
    clearTimeout(timeout);
  }
}

export default app;
