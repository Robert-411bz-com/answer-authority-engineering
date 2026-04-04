/**
 * 411bz-schema-engine — Schema.org JSON-LD generation and validation.
 */

import { Hono } from 'hono';

type Bindings = { WORKER_ID: string; AUTHORITY_INTERNAL_KEY: string };

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

app.post('/v1/generate', async (c) => {
  const key = c.req.header('X-Authority-Key');
  if (key !== c.env.AUTHORITY_INTERNAL_KEY) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json<{ business_name: string; business_type: string; domain: string }>();
  const schema = {
    '@context': 'https://schema.org',
    '@type': body.business_type || 'Organization',
    name: body.business_name,
    url: `https://${body.domain}`,
    sameAs: [],
  };
  return c.json({ schema, generated_at: new Date().toISOString() });
});

export default app;
