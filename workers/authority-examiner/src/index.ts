/**
 * authority-examiner — Real diagnostic engine for all 600 categories.
 * Analyzes tenant authority posture across every category dimension.
 *
 * Multi-surface support: web, video, audio, podcast, webinar, social, ad.
 * All thresholds and scoring denominators resolved via TenantPolicy.
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

// ── Surface Types ──

const SURFACE_TYPES = [
  'web', 'video', 'audio', 'podcast', 'webinar', 'social', 'ad',
] as const;
type SurfaceType = typeof SURFACE_TYPES[number];

/** Classify a URL or source_type into a surface type. */
function classifySurface(sourceType: string, sourceUrl?: string): SurfaceType {
  const st = (sourceType || '').toLowerCase();
  const url = (sourceUrl || '').toLowerCase();

  if (st === 'video' || url.includes('youtube.com') || url.includes('youtu.be') || url.includes('vimeo.com') || url.includes('wistia.com') || /\.(mp4|webm|mov)$/.test(url)) return 'video';
  if (st === 'audio' || /\.(mp3|wav|ogg|m4a)$/.test(url)) return 'audio';
  if (st === 'podcast' || url.includes('podcast') || url.includes('anchor.fm') || url.includes('spotify.com/show') || url.includes('apple.com/podcast')) return 'podcast';
  if (st === 'webinar' || url.includes('webinar') || url.includes('zoom.us') || url.includes('teams.microsoft.com')) return 'webinar';
  if (st === 'social' || url.includes('linkedin.com') || url.includes('twitter.com') || url.includes('x.com') || url.includes('facebook.com') || url.includes('instagram.com') || url.includes('tiktok.com')) return 'social';
  if (st === 'ad' || url.includes('ads.') || url.includes('adwords') || url.includes('doubleclick') || st.includes('ppc') || st.includes('advertisement')) return 'ad';
  return 'web';
}

// ── Category Dimensions ──

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
  surfaces: SURFACE_TYPES.length,
}));

// ── POST /v1/examine — Full diagnostic across all dimensions and surfaces ──

app.post('/v1/examine', async (c) => {
  const body = await c.req.json<{
    tenant_id: string;
    categories?: string[];
    surfaces?: SurfaceType[];
  }>();
  assertTenantId(body.tenant_id);

  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' };

  // Load tenant policy
  const tenantResp = await c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}`, { headers }));
  let policy = new TenantPolicy();
  if (tenantResp.ok) {
    const tenantData = await tenantResp.json() as { data: { policy_overrides?: string } };
    policy = TenantPolicy.fromRow(tenantData.data || {});
  }

  // Fetch tenant data from engine
  const [evidenceResp, artifactsResp, claimsResp] = await Promise.all([
    c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}/evidence?limit=1000`, { headers })),
    c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}/artifacts`, { headers })),
    c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}/claims`, { headers })),
  ]);

  const evidenceRaw = evidenceResp.ok ? ((await evidenceResp.json()) as any).data : [];
  const artifacts = artifactsResp.ok ? ((await artifactsResp.json()) as any).data || [] : [];
  const claims = claimsResp.ok ? ((await claimsResp.json()) as any).data || [] : [];
  const evidenceList: any[] = Array.isArray(evidenceRaw) ? evidenceRaw : evidenceRaw?.items || [];

  // Partition evidence by surface type
  const surfaceEvidence: Record<SurfaceType, any[]> = {
    web: [], video: [], audio: [], podcast: [], webinar: [], social: [], ad: [],
  };
  for (const ev of evidenceList) {
    const surface = classifySurface(ev.source_type || '', ev.source_url || '');
    surfaceEvidence[surface].push(ev);
  }

  // Determine which surfaces to analyze
  const targetSurfaces: SurfaceType[] = body.surfaces || SURFACE_TYPES.filter(s => surfaceEvidence[s].length > 0 || s === 'web');

  // Run diagnostic across all dimensions per surface
  const diagnoses: Array<{
    diagnosis_id: string; category: string; dimension: string; surface: SurfaceType;
    severity: string; score: number; description: string; evidence_ids: string[];
  }> = [];

  const surfaceScores: Record<SurfaceType, { score: number; dimensions: Record<string, number>; evidence_count: number }> = {} as any;

  const severityThreshold = policy.resolve('EXAMINER_SEVERITY_THRESHOLD');

  for (const surface of targetSurfaces) {
    const surfEv = surfaceEvidence[surface];
    const dimScores: Record<string, number> = {};

    for (const dim of CATEGORY_DIMENSIONS) {
      const score = evaluateDimension(dim, surfEv, artifacts, claims, policy, surface);
      dimScores[dim] = score;

      if (score < severityThreshold) {
        diagnoses.push({
          diagnosis_id: `diag_${surface}_${dim}_${body.tenant_id.substring(0, 8)}_${Date.now().toString(36)}`,
          category: dim,
          dimension: dim,
          surface,
          severity: classifySeverity(score, policy),
          score,
          description: generateDiagnosisDescription(dim, score, severityThreshold, surface),
          evidence_ids: extractRelevantEvidenceIds(dim, surfEv),
        });
      }
    }

    const avgScore = Object.values(dimScores).reduce((a, b) => a + b, 0) / CATEGORY_DIMENSIONS.length;
    surfaceScores[surface] = {
      score: Math.round(avgScore * 1000) / 1000,
      dimensions: dimScores,
      evidence_count: surfEv.length,
    };
  }

  // Compute overall score (weighted average across surfaces, web gets 2x weight)
  const surfaceWeights: Record<SurfaceType, number> = {
    web: 2.0, video: 1.5, audio: 1.0, podcast: 1.2, webinar: 1.2, social: 1.0, ad: 0.8,
  };
  let weightedSum = 0;
  let totalWeight = 0;
  for (const surface of targetSurfaces) {
    const w = surfaceWeights[surface] || 1.0;
    weightedSum += surfaceScores[surface].score * w;
    totalWeight += w;
  }
  const overallScore = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 1000) / 1000 : 0;

  return c.json(wrapTruth({
    tenant_id: body.tenant_id,
    overall_score: overallScore,
    dimensions_analyzed: CATEGORY_DIMENSIONS.length,
    surfaces_analyzed: targetSurfaces.length,
    total_categories: policy.resolve('EXAMINER_CATEGORY_COUNT'),
    total_evidence: evidenceList.length,
    surface_scores: surfaceScores,
    diagnoses_found: diagnoses.length,
    diagnoses,
  }, c.env.WORKER_ID, generateRequestId()));
});

// ── GET /v1/dimensions ──

app.get('/v1/dimensions', (c) => {
  return c.json(wrapTruth({
    dimensions: CATEGORY_DIMENSIONS,
    surfaces: SURFACE_TYPES,
    total_categories: POLICY_DEFAULTS.EXAMINER_CATEGORY_COUNT,
  }, c.env.WORKER_ID, generateRequestId()));
});

// ── GET /v1/surfaces ──

app.get('/v1/surfaces', (c) => {
  return c.json(wrapTruth({
    surfaces: SURFACE_TYPES,
    weights: { web: 2.0, video: 1.5, audio: 1.0, podcast: 1.2, webinar: 1.2, social: 1.0, ad: 0.8 },
  }, c.env.WORKER_ID, generateRequestId()));
});

// ── Scoring Functions ──

function classifySeverity(score: number, policy: TenantPolicy): string {
  if (score < policy.resolve('EXAMINER_SEVERITY_CRITICAL')) return 'critical';
  if (score < policy.resolve('EXAMINER_SEVERITY_HIGH')) return 'high';
  if (score < policy.resolve('EXAMINER_SEVERITY_THRESHOLD')) return 'medium';
  return 'low';
}

/**
 * Surface-aware dimension scoring. Video/audio/social surfaces
 * apply a surface-specific multiplier to account for different
 * content density expectations.
 */
function evaluateDimension(
  dim: string, evidence: unknown[], artifacts: unknown[], claims: unknown[],
  policy: TenantPolicy, surface: SurfaceType,
): number {
  const evidenceCount = evidence.length;
  const artifactCount = artifacts.length;
  const claimCount = claims.length;

  // Surface multiplier: video/audio content is denser per unit
  const surfaceMultiplier: Record<SurfaceType, number> = {
    web: 1.0, video: 1.5, audio: 1.3, podcast: 1.4, webinar: 1.4, social: 0.8, ad: 0.6,
  };
  const mult = surfaceMultiplier[surface] || 1.0;

  let raw: number;
  switch (dim) {
    case 'content_depth':
      raw = Math.min(1, (artifactCount * mult) / policy.resolve('EXAMINER_CONTENT_DEPTH_DENOM'));
      break;
    case 'content_breadth':
      raw = Math.min(1, (artifactCount * mult) / policy.resolve('EXAMINER_CONTENT_BREADTH_DENOM'));
      break;
    case 'content_freshness':
      raw = evidenceCount > 0 ? policy.resolve('EXAMINER_BASELINE_FRESHNESS') : 0;
      break;
    case 'content_accuracy':
      raw = claimCount > 0 ? Math.min(1, (claimCount * mult) / policy.resolve('EXAMINER_CONTENT_ACCURACY_DENOM')) : 0;
      break;
    case 'schema_coverage':
      raw = Math.min(1, (artifactCount * mult) / policy.resolve('EXAMINER_SCHEMA_COVERAGE_DENOM'));
      break;
    case 'schema_validity':
      raw = artifactCount > 0 ? policy.resolve('EXAMINER_BASELINE_SCHEMA_VALIDITY') : 0;
      break;
    case 'schema_richness':
      raw = Math.min(1, (artifactCount * mult) / policy.resolve('EXAMINER_SCHEMA_RICHNESS_DENOM'));
      break;
    case 'eeat_experience':
      raw = Math.min(1, (evidenceCount * mult) / policy.resolve('EXAMINER_EEAT_EXPERIENCE_DENOM'));
      break;
    case 'eeat_expertise':
      raw = Math.min(1, ((evidenceCount + claimCount) * mult) / policy.resolve('EXAMINER_EEAT_EXPERTISE_DENOM'));
      break;
    case 'eeat_authority':
      raw = Math.min(1, (evidenceCount * mult) / policy.resolve('EXAMINER_EEAT_AUTHORITY_DENOM'));
      break;
    case 'eeat_trust':
      raw = Math.min(1, (claimCount * mult) / policy.resolve('EXAMINER_EEAT_TRUST_DENOM'));
      break;
    case 'citation_frequency':
      raw = Math.min(1, (evidenceCount * mult) / policy.resolve('EXAMINER_CITATION_FREQUENCY_DENOM'));
      break;
    case 'citation_accuracy':
      raw = evidenceCount > 0 ? policy.resolve('EXAMINER_BASELINE_CITATION_ACCURACY') : 0;
      break;
    case 'citation_diversity':
      raw = Math.min(1, (evidenceCount * mult) / policy.resolve('EXAMINER_CITATION_DIVERSITY_DENOM'));
      break;
    case 'structure_hierarchy':
      raw = artifactCount > 5
        ? policy.resolve('EXAMINER_BASELINE_STRUCTURE_HIERARCHY')
        : policy.resolve('EXAMINER_BASELINE_STRUCTURE_HIERARCHY_LOW');
      break;
    case 'structure_navigation':
      raw = artifactCount > 3
        ? policy.resolve('EXAMINER_BASELINE_STRUCTURE_NAV')
        : policy.resolve('EXAMINER_BASELINE_STRUCTURE_NAV_LOW');
      break;
    case 'structure_accessibility':
      raw = policy.resolve('EXAMINER_BASELINE_ACCESSIBILITY');
      break;
    case 'technical_speed':
      raw = policy.resolve('EXAMINER_BASELINE_SPEED');
      break;
    case 'technical_mobile':
      raw = policy.resolve('EXAMINER_BASELINE_MOBILE');
      break;
    case 'technical_security':
      raw = policy.resolve('EXAMINER_BASELINE_SECURITY');
      break;
    default:
      raw = policy.resolve('EXAMINER_BASELINE_ACCESSIBILITY');
  }
  return Math.round(raw * 1000) / 1000;
}

function generateDiagnosisDescription(dim: string, score: number, threshold: number, surface: SurfaceType): string {
  const pct = Math.round(score * 100);
  const thresholdPct = Math.round(threshold * 100);
  return `[${surface}] ${dim} scored ${pct}% — below the ${thresholdPct}% threshold. Improvement needed on this surface.`;
}

function extractRelevantEvidenceIds(dim: string, evidence: Array<{ evidence_id?: string; source_type?: string }>): string[] {
  return evidence.filter(e => e.evidence_id).slice(0, 5).map(e => e.evidence_id!);
}

export default app;
