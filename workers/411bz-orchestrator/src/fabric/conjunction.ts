/**
 * ship_verdict — the conjunction at Point C. No model call.
 */

import type { Decision, Distribution, Thresholds } from './types.js';

export interface ShipInputs {
  proofPassed: boolean;
  dryRunPassed: boolean;
  /** null when the question failed or was never asked. */
  claimSupported: Distribution | null;
  entityDefined: Distribution | null;
  deployRoute: Distribution | null;
}

export interface ShipVerdict {
  decision: Decision;
  rule: string;
  reason: string;
}

/**
 * First match wins. Rules 1-7 are the spec order. Rules 4b and 4c are fail-closed
 * additions: without them a missing or uncertain claim_supported, or a missing
 * deploy_route, could fall through to rule 6 and proceed.
 */
export function shipVerdict(i: ShipInputs, t: Thresholds): ShipVerdict {
  const claim = i.claimSupported;
  const route = i.deployRoute;
  const entity = i.entityDefined;

  if (!i.proofPassed) return v('reject', '1', 'proof gate failed');
  if (claim && claim.primary_p < t.reject) return v('reject', '2', `claim_supported P(yes)=${claim.primary_p} < reject`);
  if (route && route.winner === 'reject') return v('reject', '3', 'deploy_route chose reject');
  if (!entity || entity.primary_p < t.review) {
    return v('pause_for_review', '4', entity ? `entity_defined P(yes)=${entity.primary_p} < review` : 'entity_defined missing');
  }
  if (!claim || claim.primary_p < t.review) {
    return v('pause_for_review', '4b', claim ? `claim_supported P(yes)=${claim.primary_p} < review` : 'claim_supported missing');
  }
  if (!route) return v('pause_for_review', '4c', 'deploy_route missing');
  if (route.winner === 'pause_for_review' || route.peakedness < t.review) {
    return v('pause_for_review', '5', `deploy_route ${route.winner} peakedness=${route.peakedness}`);
  }
  if (route.winner === 'auto_execute' && route.peakedness >= t.auto && i.dryRunPassed) {
    return v('proceed', '6', 'proof, claim, entity, dry run, and a peaked auto_execute agree');
  }
  return v('pause_for_review', '7', 'no rule cleared the deploy');
}

function v(decision: Decision, rule: string, reason: string): ShipVerdict {
  return { decision, rule, reason };
}
