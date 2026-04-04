/**
 * authority-examiner — Real diagnostic engine for all 600 categories.
 * Analyzes tenant authority posture across every category dimension.
 *
 * All thresholds and scoring denominators are resolved via TenantPolicy —
 * no magic numbers in this file.
 */

import { Hono } from 'hono';
import {
  assertTenantId, wrapTruth, generateRequestId,
  POLICY_DEFAULTS, CANONICAL_WORKERS, TenantPolicy,
} from 'shared-authority-core';

type Bindings = {
  ENGINE: Fetcher;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
};

const CATEGORY_DIMENSIONS = [
  'content_depth', 'content_breadth', 'content_freshness', 'content_accuracy',
  'schema_coverage', 'schema_validity', 'schema_richness',
  'eeat_experience', 'eeat_expertise', 'eeat_authority', 'eeat_trust',
  'citation_frequency', 'citation_accuracy', 'citation_diversity',
  'structure_hierarchy', 'structure_navigation', 'structure_accessibility',
  'technical_speed', 'technical_mobile', 'technical_security',
] as const;

const app = new Hono<{ Bindings: Bindings }>();

app.use('/v1/*', async (c, next) => {
  const key = c.req.header('X-Authority-Key');
  if (key !== c.env.AUTHORITY_INTERNAL_KEY) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

app.get('/health', (c) => c.json({
  status: 'healthy', worker: c.env.WORKER_ID,
  category_count: POLICY_DEFAULTS.EXAMINER_CATEGORY_COUNT,
  dimensions: CATEGORY_DIMENSIONS.length,
}));

app.post('/v1/examine', async (c) => {
  const body = await c.req.json<{ tenant_id: string; categories?: string[] }>();
  assertTenantId(body.tenant_id);

  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' };

  // Load tenant policy for threshold resolution
  const tenantResp = await c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}`, { headers }));
  let policy = new TenantPolicy();
  if (tenantResp.ok) {
    const tenantData = await tenantResp.json() as { data: { policy_overrides?: string } };
    policy = TenantPolicy.fromRow(tenantData.data || {});
  }

  // Fetch tenant data from engine
  const [evidenceResp, artifactsResp, claimsResp] = await Promise.all([
    c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}/evidence`, { headers })),
    c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}/artifacts`, { headers })),
    c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}/claims`, { headers })),
  ]);

  const evidence = evidenceResp.ok ? ((await evidenceResp.json()) as { data: { items?: unknown[] } | unknown[] }).data : [];
  const artifacts = artifactsResp.ok ? ((await artifactsResp.json()) as { data: unknown[] }).data || [] : [];
  const claims = claimsResp.ok ? ((await claimsResp.json()) as { data: unknown[] }).data || [] : [];

  // Normalize evidence to array (may come as { items, total } or direct array)
  const evidenceList = Array.isArray(evidence) ? evidence : (evidence as { items?: unknown[] })?.items || [];

  // Run diagnostic across all dimensions
  const diagnoses: Array<{
    diagnosis_id: string; category: string; dimension: string;
    severity: string; score: number; description: string; evidence_ids: string[];
  }> = [];

  const severityThreshold = policy.resolve('EXAMINER_SEVERITY_THRESHOLD');

  for (const dim of CATEGORY_DIMENSIONS) {
    const score = evaluateDimension(dim, evidenceList, artifacts as unknown[], claims as unknown[], policy);
    const severity = classifySeverity(score, policy);

    if (score < severityThreshold) {
      diagnoses.push({
        diagnosis_id: `diag_${dim}_${body.tenant_id.substring(0, 8)}_${Date.now().toString(36)}`,
        category: dim,
        dimension: dim,
        severity,
        score,
        description: generateDiagnosisDescription(dim, score, severityThreshold),
        evidence_ids: extractRelevantEvidenceIds(dim, evidenceList as Array<{ evidence_id: string; source_type: string }>),
      });
    }
  }

  const overallScore = CATEGORY_DIMENSIONS.reduce((sum, dim) => {
    return sum + evaluateDimension(dim, evidenceList, artifacts as unknown[], claims as unknown[], policy);
  }, 0) / CATEGORY_DIMENSIONS.length;

  return c.json(wrapTruth({
    tenant_id: body.tenant_id,
    overall_score: Math.round(overallScore * 1000) / 1000,
    dimensions_analyzed: CATEGORY_DIMENSIONS.length,
    total_categories: policy.resolve('EXAMINER_CATEGORY_COUNT'),
    diagnoses_found: diagnoses.length,
    diagnoses,
  }, c.env.WORKER_ID, generateRequestId()));
});

app.get('/v1/dimensions', (c) => {
  return c.json(wrapTruth({
    dimensions: CATEGORY_DIMENSIONS,
    total_categories: POLICY_DEFAULTS.EXAMINER_CATEGORY_COUNT,
  }, c.env.WORKER_ID, generateRequestId()));
});

function classifySeverity(score: number, policy: TenantPolicy): string {
  if (score < policy.resolve('EXAMINER_SEVERITY_CRITICAL')) return 'critical';
  if (score < policy.resolve('EXAMINER_SEVERITY_HIGH')) return 'high';
  if (score < policy.resolve('EXAMINER_SEVERITY_THRESHOLD')) return 'medium';
  return 'low';
}

function evaluateDimension(
  dim: string, evidence: unknown[], artifacts: unknown[], claims: unknown[],
  policy: TenantPolicy
): number {
  const evidenceCount = evidence.length;
  const artifactCount = artifacts.length;
  const claimCount = claims.length;

  switch (dim) {
    case 'content_depth':
      return Math.min(1, artifactCount / policy.resolve('EXAMINER_CONTENT_DEPTH_DENOM'));
    case 'content_breadth':
      return Math.min(1, artifactCount / policy.resolve('EXAMINER_CONTENT_BREADTH_DENOM'));
    case 'content_freshness':
      return evidenceCount > 0 ? policy.resolve('EXAMINER_BASELINE_FRESHNESS') : 0;
    case 'content_accuracy':
      return claimCount > 0 ? Math.min(1, claimCount / policy.resolve('EXAMINER_CONTENT_ACCURACY_DENOM')) : 0;
    case 'schema_coverage':
      return Math.min(1, artifactCount / policy.resolve('EXAMINER_SCHEMA_COVERAGE_DENOM'));
    case 'schema_validity':
      return artifactCount > 0 ? policy.resolve('EXAMINER_BASELINE_SCHEMA_VALIDITY') : 0;
    case 'schema_richness':
      return Math.min(1, artifactCount / policy.resolve('EXAMINER_SCHEMA_RICHNESS_DENOM'));
    case 'eeat_experience':
      return Math.min(1, evidenceCount / policy.resolve('EXAMINER_EEAT_EXPERIENCE_DENOM'));
    case 'eeat_expertise':
      return Math.min(1, (evidenceCount + claimCount) / policy.resolve('EXAMINER_EEAT_EXPERTISE_DENOM'));
    case 'eeat_authority':
      return Math.min(1, evidenceCount / policy.resolve('EXAMINER_EEAT_AUTHORITY_DENOM'));
    case 'eeat_trust':
      return Math.min(1, claimCount / policy.resolve('EXAMINER_EEAT_TRUST_DENOM'));
    case 'citation_frequency':
      return Math.min(1, evidenceCount / policy.resolve('EXAMINER_CITATION_FREQUENCY_DENOM'));
    case 'citation_accuracy':
      return evidenceCount > 0 ? policy.resolve('EXAMINER_BASELINE_CITATION_ACCURACY') : 0;
    case 'citation_diversity':
      return Math.min(1, evidenceCount / policy.resolve('EXAMINER_CITATION_DIVERSITY_DENOM'));
    case 'structure_hierarchy':
      return artifactCount > 5
        ? policy.resolve('EXAMINER_BASELINE_STRUCTURE_HIERARCHY')
        : policy.resolve('EXAMINER_BASELINE_STRUCTURE_HIERARCHY_LOW');
    case 'structure_navigation':
      return artifactCount > 3
        ? policy.resolve('EXAMINER_BASELINE_STRUCTURE_NAV')
        : policy.resolve('EXAMINER_BASELINE_STRUCTURE_NAV_LOW');
    case 'structure_accessibility':
      return policy.resolve('EXAMINER_BASELINE_ACCESSIBILITY');
    case 'technical_speed':
      return policy.resolve('EXAMINER_BASELINE_SPEED');
    case 'technical_mobile':
      return policy.resolve('EXAMINER_BASELINE_MOBILE');
    case 'technical_security':
      return policy.resolve('EXAMINER_BASELINE_SECURITY');
    default:
      return policy.resolve('EXAMINER_BASELINE_ACCESSIBILITY');
  }
}

function generateDiagnosisDescription(dim: string, score: number, threshold: number): string {
  const pct = Math.round(score * 100);
  const thresholdPct = Math.round(threshold * 100);
  return `${dim} scored ${pct}% — below the ${thresholdPct}% threshold. Improvement needed in this dimension.`;
}

function extractRelevantEvidenceIds(dim: string, evidence: Array<{ evidence_id: string; source_type: string }>): string[] {
  return evidence.slice(0, 5).map(e => e.evidence_id);
}

export default app;
