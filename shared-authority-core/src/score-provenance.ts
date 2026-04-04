/**
 * Score provenance — every score must trace to its computation inputs.
 * No score exists without provenance.
 */

import { POLICY_DEFAULTS } from './policy-defaults.js';

export interface ScoreProvenance {
  tenant_id: string;
  score_type: 'aii' | 'category' | 'dimension';
  score_value: number;
  computed_at: string;
  inputs: ScoreInput[];
  weights_used: Record<string, number>;
  version: number;
}

export interface ScoreInput {
  dimension: string;
  raw_value: number;
  normalized_value: number;
  weight: number;
  source_evidence_ids: string[];
}

export function computeAII(inputs: ScoreInput[]): { score: number; provenance: ScoreInput[] } {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const input of inputs) {
    weightedSum += input.normalized_value * input.weight;
    totalWeight += input.weight;
  }
  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return { score: Math.round(score * 1000) / 1000, provenance: inputs };
}

export function getDefaultWeights(): Record<string, number> {
  return {
    content: POLICY_DEFAULTS.AII_WEIGHT_CONTENT,
    schema: POLICY_DEFAULTS.AII_WEIGHT_SCHEMA,
    eeat: POLICY_DEFAULTS.AII_WEIGHT_EEAT,
    citations: POLICY_DEFAULTS.AII_WEIGHT_CITATIONS,
    freshness: POLICY_DEFAULTS.AII_WEIGHT_FRESHNESS,
    structure: POLICY_DEFAULTS.AII_WEIGHT_STRUCTURE,
  };
}
