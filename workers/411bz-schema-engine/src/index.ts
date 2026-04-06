/**
 * 411bz-schema-engine — Schema.org analysis, generation, and validation.
 * Provides POST /v1/examine for multi-surface schema analysis,
 * and POST /v1/generate for JSON-LD generation.
 */

import { Hono } from 'hono';
import {
  assertTenantId, computeContentHash, wrapTruth, generateRequestId,
  POLICY_DEFAULTS, CANONICAL_WORKERS,
} from 'shared-authority-core';

type Bindings = {
  DB: D1Database;
  ENGINE: Fetcher;
  OBSERVATORY: Fetcher;
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

/**
 * POST /v1/examine — Multi-surface schema analysis.
 * Probes the tenant domain via observatory, analyzes schema presence,
 * and produces findings with evidence linkage.
 */
app.post('/v1/examine', async (c) => {
  const body = await c.req.json<{ tenant_id: string; domain?: string }>();
  assertTenantId(body.tenant_id);

  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' };

  // Get tenant info from engine
  const tenantResp = await c.env.ENGINE.fetch(new Request(
    `http://internal/v1/tenants/${body.tenant_id}`, { headers }
  ));
  if (!tenantResp.ok) return c.json({ error: 'tenant_not_found' }, 404);
  const tenantData = await tenantResp.json() as { data: { domain: string; business_name: string; business_type: string } };
  const domain = body.domain || tenantData.data?.domain;
  if (!domain) return c.json({ error: 'no_domain' }, 400);

  // Probe domain via observatory
  const probeResp = await c.env.OBSERVATORY.fetch(new Request('http://internal/v1/probe', {
    method: 'POST', headers,
    body: JSON.stringify({ tenant_id: body.tenant_id, domain }),
  }));
  const probeData = probeResp.ok
    ? await probeResp.json() as { data: { probes: Array<{ probe: string; status: number; has_content: boolean }> } }
    : null;

  const probes = probeData?.data?.probes || [];

  // Analyze schema surfaces
  const findings: Array<{
    finding_id: string; surface: string; severity: string;
    category: string; description: string; recommendation: string;
  }> = [];

  // Check homepage for JSON-LD
  const homepage = probes.find(p => p.probe === 'homepage');
  if (!homepage || !homepage.has_content) {
    findings.push({
      finding_id: `f_homepage_${Date.now().toString(36)}`,
      surface: 'homepage',
      severity: 'critical',
      category: 'schema_coverage',
      description: 'Homepage is unreachable or has no content.',
      recommendation: 'Ensure homepage is accessible and contains structured data.',
    });
  }

  // Check schema.json
  const schemaProbe = probes.find(p => p.probe === 'schema');
  if (!schemaProbe || schemaProbe.status !== 200) {
    findings.push({
      finding_id: `f_schema_${Date.now().toString(36)}`,
      surface: '/.well-known/schema.json',
      severity: 'high',
      category: 'schema_coverage',
      description: 'No /.well-known/schema.json found. LLMs and crawlers cannot discover structured data.',
      recommendation: 'Deploy a schema.json file with Organization, FAQPage, and service schemas.',
    });
  }

  // Check llms.txt
  const llmsProbe = probes.find(p => p.probe === 'llms_txt');
  if (!llmsProbe || llmsProbe.status !== 200) {
    findings.push({
      finding_id: `f_llms_${Date.now().toString(36)}`,
      surface: '/llms.txt',
      severity: 'high',
      category: 'llm_visibility',
      description: 'No /llms.txt found. LLMs cannot discover this business for citation.',
      recommendation: 'Deploy an llms.txt file with business identity, services, and authority signals.',
    });
  }

  // Check robots.txt
  const robotsProbe = probes.find(p => p.probe === 'robots');
  if (!robotsProbe || robotsProbe.status !== 200) {
    findings.push({
      finding_id: `f_robots_${Date.now().toString(36)}`,
      surface: '/robots.txt',
      severity: 'medium',
      category: 'technical_seo',
      description: 'No robots.txt found. Crawlers may not index content optimally.',
      recommendation: 'Deploy a robots.txt with proper allow/disallow directives and sitemap reference.',
    });
  }

  // Check sitemap
  const sitemapProbe = probes.find(p => p.probe === 'sitemap');
  if (!sitemapProbe || sitemapProbe.status !== 200) {
    findings.push({
      finding_id: `f_sitemap_${Date.now().toString(36)}`,
      surface: '/sitemap.xml',
      severity: 'medium',
      category: 'technical_seo',
      description: 'No sitemap.xml found. Search engines cannot discover all pages.',
      recommendation: 'Deploy a sitemap.xml listing all authority pages.',
    });
  }

  // Schema type coverage analysis
  const requiredSchemaTypes = [
    'Organization', 'LocalBusiness', 'FAQPage', 'HowTo',
    'Article', 'WebPage', 'BreadcrumbList', 'Service',
  ];
  findings.push({
    finding_id: `f_types_${Date.now().toString(36)}`,
    surface: 'schema_types',
    severity: 'medium',
    category: 'schema_richness',
    description: `Schema type coverage analysis: ${requiredSchemaTypes.length} recommended types should be present.`,
    recommendation: `Ensure JSON-LD includes: ${requiredSchemaTypes.join(', ')}.`,
  });

  // Compute overall schema health score
  const totalSurfaces = 5; // homepage, schema, llms, robots, sitemap
  const presentSurfaces = probes.filter(p => p.status >= 200 && p.status < 400).length;
  const schemaHealthScore = Math.round((presentSurfaces / totalSurfaces) * 100) / 100;

  // Persist findings
  const examId = `exam_schema_${body.tenant_id.substring(0, 8)}_${Date.now().toString(36)}`;
  await c.env.DB.prepare(
    'INSERT INTO schema_exams (exam_id, tenant_id, domain, findings, score, examined_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
  ).bind(examId, body.tenant_id, domain, JSON.stringify(findings), schemaHealthScore).run();

  return c.json(wrapTruth({
    exam_id: examId,
    tenant_id: body.tenant_id,
    domain,
    schema_health_score: schemaHealthScore,
    surfaces_present: presentSurfaces,
    surfaces_total: totalSurfaces,
    findings_count: findings.length,
    findings,
  }, c.env.WORKER_ID, generateRequestId()));
});

// ── Generate JSON-LD ──
app.post('/v1/generate', async (c) => {
  const body = await c.req.json<{
    tenant_id?: string; business_name: string;
    business_type: string; domain: string;
    additional_types?: string[];
  }>();

  const schemas: unknown[] = [];

  // Organization schema
  schemas.push({
    '@context': 'https://schema.org',
    '@type': body.business_type || 'Organization',
    name: body.business_name,
    url: `https://${body.domain}`,
    sameAs: [],
  });

  // WebPage schema
  schemas.push({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: `${body.business_name} — Official Website`,
    url: `https://${body.domain}`,
    isPartOf: { '@type': 'WebSite', url: `https://${body.domain}` },
  });

  // FAQPage schema stub
  schemas.push({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [],
  });

  const content = JSON.stringify(schemas, null, 2);
  const contentHash = await computeContentHash(content);

  // Persist if tenant_id provided
  if (body.tenant_id) {
    assertTenantId(body.tenant_id);
    const genId = `sgen_${body.tenant_id.substring(0, 8)}_${Date.now().toString(36)}`;
    await c.env.DB.prepare(
      'INSERT INTO schema_generations (generation_id, tenant_id, domain, schemas, content_hash, generated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
    ).bind(genId, body.tenant_id, body.domain, content, contentHash).run();
  }

  return c.json({ schemas, content_hash: contentHash, generated_at: new Date().toISOString() });
});

// ── Exam history ──
app.get('/v1/exams/:tenant_id', async (c) => {
  const tid = c.req.param('tenant_id');
  assertTenantId(tid);
  const rows = await c.env.DB.prepare(
    'SELECT * FROM schema_exams WHERE tenant_id = ? ORDER BY examined_at DESC LIMIT 50'
  ).bind(tid).all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

export default app;
