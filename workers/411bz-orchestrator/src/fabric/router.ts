/**
 * Lane pick + CWAR for Fabric questions.
 */

import type { QuestionDef } from './questions.js';
import type { CalibrationRow, Cwar, Distribution, FabricPolicy, Lane, Thresholds } from './types.js';

export interface LaneContext {
  replayHit: boolean;
  calibration: CalibrationRow | null;
}

/**
 * Lanes, first match wins:
 *   1 structural  -> deterministic, zero tokens
 *   2 conjunction -> ship_verdict, zero tokens
 *   3 replay      -> same question + same content hash already answered by an earlier slip
 *   4 local       -> force-local, or auto with enough labels and a better Brier score
 *   5 shadow      -> Jev answers; the local head is scored beside it and cannot block
 *   6 jev
 */
export function pickLane(def: QuestionDef, ctx: LaneContext, policy: FabricPolicy): Lane {
  if (def.kind === 'structural') return 'structural';
  if (def.kind === 'conjunction') return 'conjunction';
  if (ctx.replayHit) return 'replay';

  const cal = ctx.calibration;
  const mode = cal?.mode ?? 'auto';
  if (mode === 'force-local') return 'local';
  if (
    mode === 'auto' && cal &&
    cal.labels >= policy.promotionMinLabels &&
    cal.local_brier !== null && cal.jev_brier !== null &&
    cal.local_brier + policy.promotionBrierMargin < cal.jev_brier
  ) {
    return 'local';
  }
  if (mode === 'shadow') return 'shadow';
  return 'jev';
}

/**
 * CWAR for one answered question. Thresholds come from TenantPolicy.
 *
 * A gating Noul reads P(yes). A Noul of 0.05 is a confident no and must not ship,
 * even though its peakedness is 0.90.
 */
export function cwar(def: QuestionDef, dist: Distribution, t: Thresholds): Cwar {
  switch (def.gate) {
    case 'noul_gate':
      if (dist.primary_p < t.reject) return 'reject';
      if (dist.primary_p < t.review) return 'pause_for_review';
      return 'proceed';

    case 'deploy_route':
      if (dist.winner === 'reject') return 'reject';
      if (dist.winner === 'pause_for_review') return 'pause_for_review';
      if (dist.peakedness < t.review) return 'pause_for_review';
      if (dist.peakedness < t.auto) return 'pause_for_review';
      return 'proceed';

    case 'cure_family':
      if (dist.winner === 'none') return 'proceed';
      if (dist.peakedness < t.review) return 'pause_for_review';
      return 'proceed';

    case 'not_a_gate':
      return 'not_a_gate';
  }
}

/** What CWAR records when a question could not be answered. Gates fail closed. */
export function cwarOnError(def: QuestionDef): Cwar {
  return def.gate === 'not_a_gate' ? 'not_a_gate' : 'pause_for_review';
}
