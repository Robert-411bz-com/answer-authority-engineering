/**
 * Fabric — the decision gate around TypeSafe Jev.
 * Jev is the cold-start prior. The examiner keeps the ruler.
 */

export type FabricMode = 'off' | 'shadow' | 'gate';
export type Decision = 'reject' | 'pause_for_review' | 'proceed';
export type Cwar = Decision | 'not_a_gate';
export type Lane = 'structural' | 'conjunction' | 'replay' | 'local' | 'shadow' | 'jev';
export type QuestionType = 'noul' | 'choice' | 'score';
export type CalibrationMode = 'auto' | 'shadow' | 'force-local';

export const DECISIONS: readonly Decision[] = ['reject', 'pause_for_review', 'proceed'];

/**
 * One answer, normalized across question types.
 * - Noul:   probabilities { yes, no }, primary_p = P(yes). Gate on primary_p, never peakedness.
 * - Choice: probabilities per option, primary_p = top probability.
 * - Score:  probabilities per level index ("0".."n-1"), primary_p = top probability.
 * peakedness = top probability minus second.
 */
export interface Distribution {
  probabilities: Record<string, number>;
  winner: string;
  primary_p: number;
  peakedness: number;
}

export interface Thresholds {
  reject: number;
  review: number;
  auto: number;
}

export interface CalibrationRow {
  question_id: string;
  labels: number;
  local_brier: number | null;
  jev_brier: number | null;
  mode: CalibrationMode;
}

export interface FabricPolicy {
  thresholds: Thresholds;
  jevTimeoutMs: number;
  promotionMinLabels: number;
  promotionBrierMargin: number;
  probabilitySumTolerance: number;
}

/**
 * The local head: a small calibrated model on our own features.
 * It ships inert. Promotion is a data change (fabric_calibration), not a code change.
 */
export interface LocalHead {
  predict(questionId: string, state: unknown): Distribution | null;
}

export const INERT_LOCAL_HEAD: LocalHead = { predict: () => null };

export interface JevConfig {
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  fetch: typeof fetch;
  probabilitySumTolerance: number;
}
