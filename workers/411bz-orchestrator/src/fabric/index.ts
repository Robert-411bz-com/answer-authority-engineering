/**
 * Fabric — the decision gate around TypeSafe Jev.
 *
 * Jev is not the writer, not the examiner, and not a drop-in LLM. It is the cold-start
 * prior; the examiner keeps the ruler. The orchestrator imports this module, and the
 * bot worker calls routeUtterance() from it. No other worker learns the Jev URL.
 */

import type { TenantPolicy } from 'shared-authority-core';
import { callSystemOne, fromNoul } from './client.js';
import { QUESTIONS, instance, type QuestionDef, type QuestionInstance } from './questions.js';
import { contentHashFor, lookupReplay, stableStringify, storeReplay } from './replay.js';
import { cwar, cwarOnError, pickLane } from './router.js';
import { newSlipId, writeSlip, type Slip } from './slips.js';
import type {
  CalibrationRow, Cwar, Distribution, FabricMode, FabricPolicy, JevConfig, Lane, LocalHead, Thresholds,
} from './types.js';

export * from './types.js';
export { QUESTIONS, instance, type QuestionInstance } from './questions.js';
export { shipVerdict, type ShipInputs, type ShipVerdict } from './conjunction.js';
export { loadCalibration } from './slips.js';

const MODES: readonly FabricMode[] = ['off', 'shadow', 'gate'];

/**
 * Missing -> shadow (the documented default). An unrecognized value also runs as
 * shadow: it never blocks a deploy, and it never silently switches Fabric off.
 */
export function parseFabricMode(raw: string | undefined): FabricMode {
  const v = (raw ?? '').trim().toLowerCase();
  return (MODES as readonly string[]).includes(v) ? (v as FabricMode) : 'shadow';
}

export function thresholdsFrom(policy: TenantPolicy): Thresholds {
  return {
    reject: policy.resolve('CONFIDENCE_THRESHOLD_REJECT'),
    review: policy.resolve('CONFIDENCE_THRESHOLD_REVIEW'),
    auto: policy.resolve('CONFIDENCE_THRESHOLD_AUTO'),
  };
}

export function fabricPolicyFrom(policy: TenantPolicy): FabricPolicy {
  return {
    thresholds: thresholdsFrom(policy),
    jevTimeoutMs: policy.resolve('FABRIC_JEV_TIMEOUT_MS'),
    promotionMinLabels: policy.resolve('FABRIC_LOCAL_PROMOTION_MIN_LABELS'),
    promotionBrierMargin: policy.resolve('FABRIC_LOCAL_PROMOTION_BRIER_MARGIN'),
    probabilitySumTolerance: policy.resolve('FABRIC_PROBABILITY_SUM_TOLERANCE'),
  };
}

export interface FabricContext {
  db: D1Database;
  runId: string;
  policy: FabricPolicy;
  jev: JevConfig;
  localHead: LocalHead;
  calibration: Map<string, CalibrationRow>;
}

export interface Answer {
  inst: QuestionInstance;
  lane: Lane;
  dist: Distribution | null;
  cwar: Cwar;
  error: string | null;
  slip_id: string;
}

/**
 * Evaluate every semantic question at one request point. All Jev-lane questions share
 * one state and go out in one request. Writes one slip per question.
 */
export async function evaluatePoint(
  ctx: FabricContext, stage: string, state: unknown, instances: QuestionInstance[],
): Promise<Map<string, Answer>> {
  const stateJson = stableStringify(state);
  const t = ctx.policy.thresholds;

  type Pending = { inst: QuestionInstance; hash: string; lane: Lane; slip_id: string; replayFrom?: string; dist?: Distribution };
  const pending: Pending[] = [];
  for (const inst of instances) {
    const hash = await contentHashFor(stateJson, inst);
    const hit = await lookupReplay(ctx.db, inst.def.id, hash);
    const lane = pickLane(inst.def, { replayHit: hit !== null, calibration: ctx.calibration.get(inst.def.id) ?? null }, ctx.policy);
    pending.push({
      inst, hash, lane, slip_id: newSlipId(ctx.runId, inst.def.id),
      ...(hit ? { replayFrom: hit.source_slip_id, dist: hit.dist } : {}),
    });
  }

  // One Jev request for every jev/shadow question at this point.
  const toJev = pending.filter(p => p.lane === 'jev' || p.lane === 'shadow');
  let jevModel: string | null = null;
  let jevTokens = 0;
  let jevErrors: Record<string, string> = {};
  let jevFailure: string | null = null;
  if (toJev.length > 0) {
    try {
      const res = await callSystemOne(ctx.jev, state, toJev.map(p => p.inst));
      jevModel = res.model;
      jevTokens = res.tokens;
      jevErrors = res.errors;
      for (const p of toJev) {
        const d = res.answers[p.inst.key];
        if (d) p.dist = d;
      }
    } catch (err) {
      jevFailure = (err as Error).message;
    }
  }

  const out = new Map<string, Answer>();
  let tokensAttributed = false;
  for (const p of pending) {
    const detail: Record<string, unknown> = {};
    let error: string | null = null;

    if (p.lane === 'replay') {
      detail.replayed_from = p.replayFrom;
    } else if (p.lane === 'local') {
      const d = ctx.localHead.predict(p.inst.def.id, state);
      if (d) p.dist = d;
      else error = 'local head is inert; no local prediction';
    } else if (p.lane === 'jev' || p.lane === 'shadow') {
      error = jevFailure ?? jevErrors[p.inst.key] ?? null;
      if (p.lane === 'shadow') {
        const local = ctx.localHead.predict(p.inst.def.id, state);
        if (local) detail.local = local;
      }
    }
    if (error) {
      p.dist = undefined;
      detail.error = error;
    }

    const dist = p.dist ?? null;
    const decision = dist ? cwar(p.inst.def, dist, t) : cwarOnError(p.inst.def);
    const isJev = p.lane === 'jev' || p.lane === 'shadow';
    // TypeSafe reports usage per request; it is attributed to the first Jev slip so SUM(tokens) is exact.
    const tokens = isJev && !tokensAttributed ? jevTokens : 0;
    if (isJev) tokensAttributed = true;

    const slip: Slip = {
      slip_id: p.slip_id, run_id: ctx.runId, stage, question_id: p.inst.def.id, subject: p.inst.subject,
      content_hash: p.hash, lane: p.lane, dist, cwar: decision, tokens,
      model_id: isJev ? (jevModel ?? ctx.jev.model) : null,
      detail: Object.keys(detail).length > 0 ? detail : null,
    };
    await writeSlip(ctx.db, slip);
    if (isJev && dist) await storeReplay(ctx.db, p.inst.def.id, p.hash, dist, p.slip_id);

    out.set(p.inst.key, { inst: p.inst, lane: p.lane, dist, cwar: decision, error, slip_id: p.slip_id });
  }
  return out;
}

/** A semantic question that could not be asked (its inputs are missing). Gates fail closed. */
export async function recordUnanswered(
  ctx: FabricContext, stage: string, inst: QuestionInstance, error: string,
): Promise<Answer> {
  const decision = cwarOnError(inst.def);
  const slip_id = newSlipId(ctx.runId, inst.def.id);
  await writeSlip(ctx.db, {
    slip_id, run_id: ctx.runId, stage, question_id: inst.def.id, subject: inst.subject, content_hash: null,
    lane: 'jev', dist: null, cwar: decision, tokens: 0, model_id: null, detail: { error },
  });
  return { inst, lane: 'jev', dist: null, cwar: decision, error, slip_id };
}

/** Structural question: answered from an existing signal. Zero tokens, no fetch. */
export async function recordStructural(
  ctx: FabricContext, stage: string, def: QuestionDef, subject: string | null,
  passed: boolean, detail: Record<string, unknown>,
): Promise<Answer> {
  const dist = fromNoul(passed ? 1 : 0);
  const decision = cwar(def, dist, ctx.policy.thresholds);
  const slip_id = newSlipId(ctx.runId, def.id);
  await writeSlip(ctx.db, {
    slip_id, run_id: ctx.runId, stage, question_id: def.id, subject, content_hash: null,
    lane: 'structural', dist, cwar: decision, tokens: 0, model_id: null, detail,
  });
  return { inst: instance(def, subject), lane: 'structural', dist, cwar: decision, error: null, slip_id };
}

/** ship_verdict slip: the conjunction, zero tokens. `winner` may differ from the decision (e.g. operator_resumed). */
export async function recordConjunction(
  ctx: FabricContext, stage: string, winner: string, decision: Cwar, detail: Record<string, unknown>,
): Promise<string> {
  const probabilities: Record<string, number> = { reject: 0, pause_for_review: 0, proceed: 0 };
  if (decision !== 'not_a_gate') probabilities[decision] = 1;
  const slip_id = newSlipId(ctx.runId, 'ship_verdict');
  await writeSlip(ctx.db, {
    slip_id, run_id: ctx.runId, stage, question_id: 'ship_verdict', subject: null, content_hash: null,
    lane: 'conjunction', dist: { probabilities, winner, primary_p: 1, peakedness: 1 },
    cwar: decision, tokens: 0, model_id: null, detail,
  });
  return slip_id;
}

// ── Bots ──

export type UtteranceAction = 'answer' | 'qualify' | 'escalate';

export interface UtteranceRoute {
  action: UtteranceAction;
  intent: string | null;
  urgency: number | null;
  pii: number | null;
  lane: Lane;
  reason: string;
  /** False when the raw text must not reach the generative model. */
  forward_text: boolean;
  model_id: string | null;
}

/**
 * Fabric decides whether the generative bot may speak. The bot still does the speaking,
 * from approved copy only. Same thresholds as the pipeline; no new policy table.
 * Fails closed: if Jev is unavailable or a safety question is unanswered, a human takes it.
 */
export async function routeUtterance(
  text: string, deps: { jev: JevConfig; thresholds: Thresholds },
): Promise<UtteranceRoute> {
  const t = deps.thresholds;
  const insts = [instance(QUESTIONS.utterance_intent), instance(QUESTIONS.utterance_urgent), instance(QUESTIONS.utterance_pii)];
  const base = { lane: 'jev' as Lane, intent: null, urgency: null, pii: null, model_id: null };

  let res;
  try {
    res = await callSystemOne(deps.jev, { utterance: text }, insts);
  } catch (err) {
    return { ...base, action: 'escalate', forward_text: false, reason: `Fabric unavailable (${(err as Error).message}); a human takes it` };
  }
  const intent = res.answers[insts[0]!.key] ?? null;
  const urgent = res.answers[insts[1]!.key] ?? null;
  const pii = res.answers[insts[2]!.key] ?? null;
  const out = {
    ...base, model_id: res.model,
    intent: intent?.winner ?? null, urgency: urgent?.primary_p ?? null, pii: pii?.primary_p ?? null,
  };

  if (!pii) return { ...out, action: 'escalate', forward_text: false, reason: 'PII check unanswered; not forwarding text' };
  if (pii.primary_p >= t.review) return { ...out, action: 'escalate', forward_text: false, reason: 'possible secret or personal identifier' };
  if (!urgent) return { ...out, action: 'escalate', forward_text: true, reason: 'urgency check unanswered' };
  if (urgent.primary_p >= t.review) return { ...out, action: 'escalate', forward_text: true, reason: 'urgent; a human handles it before the bot improvises' };
  if (!intent || intent.peakedness < t.review) return { ...out, action: 'qualify', forward_text: true, reason: 'intent unclear; ask one question, no pitch' };
  if (intent.winner === 'sales') return { ...out, action: 'qualify', forward_text: true, reason: 'sales intent; qualify, never invent a price' };
  return { ...out, action: 'answer', forward_text: true, reason: 'answer from approved copy only' };
}
