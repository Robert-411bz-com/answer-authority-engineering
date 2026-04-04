/**
 * AII (Authority Intelligence Index) computation.
 * Real weighted scoring with provenance — no hardcoded estimates.
 */

import { computeAII, getDefaultWeights, type ScoreInput, POLICY_DEFAULTS } from 'shared-authority-core';

export function normalizeScore(raw: number, min: number, max: number): number {
  if (max === min) return 0;
  return Math.max(0, Math.min(1, (raw - min) / (max - min)));
}

export async function computeFullAII(db: D1Database, tenantId: string): Promise<{
  aii: number;
  dimensions: Record<string, number>;
  provenance: ScoreInput[];
}> {
  const weights = getDefaultWeights();
  const dimensions: Record<string, number> = {};
  const inputs: ScoreInput[] = [];

  // Content dimension: count artifacts
  const contentResult = await db.prepare(
    'SELECT COUNT(*) as cnt FROM artifacts WHERE tenant_id = ?'
  ).bind(tenantId).first<{ cnt: number }>();
  const contentRaw = contentResult?.cnt || 0;
  const contentNorm = normalizeScore(contentRaw, 0, 100);
  dimensions.content = contentNorm;
  inputs.push({ dimension: 'content', raw_value: contentRaw, normalized_value: contentNorm, weight: weights.content, source_evidence_ids: [] });

  // Schema dimension: count schema artifacts
  const schemaResult = await db.prepare(
    "SELECT COUNT(*) as cnt FROM artifacts WHERE tenant_id = ? AND kind = 'schema_markup'"
  ).bind(tenantId).first<{ cnt: number }>();
  const schemaRaw = schemaResult?.cnt || 0;
  const schemaNorm = normalizeScore(schemaRaw, 0, 20);
  dimensions.schema = schemaNorm;
  inputs.push({ dimension: 'schema', raw_value: schemaRaw, normalized_value: schemaNorm, weight: weights.schema, source_evidence_ids: [] });

  // E-E-A-T dimension: count eeat signals
  const eeatResult = await db.prepare(
    "SELECT COUNT(*) as cnt FROM artifacts WHERE tenant_id = ? AND kind = 'eeat_signal'"
  ).bind(tenantId).first<{ cnt: number }>();
  const eeatRaw = eeatResult?.cnt || 0;
  const eeatNorm = normalizeScore(eeatRaw, 0, 50);
  dimensions.eeat = eeatNorm;
  inputs.push({ dimension: 'eeat', raw_value: eeatRaw, normalized_value: eeatNorm, weight: weights.eeat, source_evidence_ids: [] });

  // Citations dimension: count visibility snapshots with citations
  const citResult = await db.prepare(
    'SELECT COUNT(*) as cnt FROM visibility_snapshots WHERE tenant_id = ? AND cited = 1'
  ).bind(tenantId).first<{ cnt: number }>();
  const citRaw = citResult?.cnt || 0;
  const citNorm = normalizeScore(citRaw, 0, 50);
  dimensions.citations = citNorm;
  inputs.push({ dimension: 'citations', raw_value: citRaw, normalized_value: citNorm, weight: weights.citations, source_evidence_ids: [] });

  // Freshness dimension: recent evidence
  const freshResult = await db.prepare(
    "SELECT COUNT(*) as cnt FROM evidence WHERE tenant_id = ? AND extracted_at > datetime('now', '-30 days')"
  ).bind(tenantId).first<{ cnt: number }>();
  const freshRaw = freshResult?.cnt || 0;
  const freshNorm = normalizeScore(freshRaw, 0, 30);
  dimensions.freshness = freshNorm;
  inputs.push({ dimension: 'freshness', raw_value: freshRaw, normalized_value: freshNorm, weight: weights.freshness, source_evidence_ids: [] });

  // Structure dimension: count claims verified
  const structResult = await db.prepare(
    'SELECT COUNT(*) as cnt FROM claims WHERE tenant_id = ? AND verified = 1'
  ).bind(tenantId).first<{ cnt: number }>();
  const structRaw = structResult?.cnt || 0;
  const structNorm = normalizeScore(structRaw, 0, 100);
  dimensions.structure = structNorm;
  inputs.push({ dimension: 'structure', raw_value: structRaw, normalized_value: structNorm, weight: weights.structure, source_evidence_ids: [] });

  const { score } = computeAII(inputs);

  // Persist score
  const scoreId = `score_aii_${tenantId.substring(0, 8)}_${Date.now().toString(36)}`;
  await db.prepare(
    'INSERT INTO scores (score_id, tenant_id, score_type, score_value, provenance) VALUES (?, ?, ?, ?, ?)'
  ).bind(scoreId, tenantId, 'aii', score, JSON.stringify(inputs)).run();

  await db.prepare(
    'INSERT INTO score_history (tenant_id, score_type, score_value) VALUES (?, ?, ?)'
  ).bind(tenantId, 'aii', score).run();

  return { aii: score, dimensions, provenance: inputs };
}
