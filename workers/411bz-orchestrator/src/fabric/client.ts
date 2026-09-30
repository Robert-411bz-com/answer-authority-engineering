/**
 * TypeSafe System One client. The only file that knows the Jev URL.
 *
 * Contract (docs.typesafe.ai/api):
 *   POST /v1/systemone  { state, model, questions: { key: { type, instructions, criteria? } } }
 *   200 -> { model, answers: { key: { type, noul?, choice?, score?, probabilities?, confidence? } }, usage }
 *
 * Fail closed: any transport error, non-2xx, timeout, or malformed answer throws or is
 * reported per key. Callers turn that into pause_for_review. Nothing here synthesizes a value.
 */

import type { QuestionInstance } from './questions.js';
import type { Distribution, JevConfig } from './types.js';

const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';

export class FabricCallError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FabricCallError';
  }
}

export interface SystemOneResult {
  /** Versioned model id reported by TypeSafe (e.g. jev-1.13.0), not the alias we asked for. */
  model: string;
  answers: Record<string, Distribution>;
  /** Per-key failures: missing or malformed answers. */
  errors: Record<string, string>;
  tokens: number;
}

interface WireAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export async function callSystemOne(
  cfg: JevConfig,
  state: unknown,
  instances: QuestionInstance[],
): Promise<SystemOneResult> {
  if (!cfg.apiKey) throw new FabricCallError('TYPESAFE_API_KEY is not set');

  const questions: Record<string, { type: string; instructions: string; criteria?: unknown }> = {};
  for (const inst of instances) {
    questions[inst.key] = {
      type: inst.def.type,
      instructions: inst.instructions,
      ...(inst.def.criteria ? { criteria: inst.def.criteria } : {}),
    };
  }

  let resp: Response;
  try {
    resp = await cfg.fetch(SYSTEM_ONE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: cfg.model, questions }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    throw new FabricCallError(`TypeSafe request failed: ${(err as Error).message}`);
  }
  if (!resp.ok) throw new FabricCallError(`TypeSafe HTTP ${resp.status}`, resp.status);

  let body: { model?: string; answers?: Record<string, WireAnswer>; usage?: { input_tokens?: number; output_tokens?: number } };
  try {
    body = await resp.json();
  } catch {
    throw new FabricCallError('TypeSafe returned a body that is not JSON');
  }
  if (typeof body.model !== 'string' || !body.answers || typeof body.answers !== 'object') {
    throw new FabricCallError('TypeSafe response is missing model or answers');
  }

  const answers: Record<string, Distribution> = {};
  const errors: Record<string, string> = {};
  for (const inst of instances) {
    const wire = body.answers[inst.key];
    if (!wire) {
      errors[inst.key] = 'no answer returned for this question';
      continue;
    }
    try {
      answers[inst.key] = toDistribution(inst, wire, cfg.probabilitySumTolerance);
    } catch (err) {
      errors[inst.key] = (err as Error).message;
    }
  }

  const usage = body.usage || {};
  return {
    model: body.model,
    answers,
    errors,
    tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
  };
}

function toDistribution(inst: QuestionInstance, wire: WireAnswer, tolerance: number): Distribution {
  if (inst.def.type === 'noul') {
    const p = wire.noul;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error('noul answer is not a probability in [0, 1]');
    }
    return fromNoul(p);
  }
  const probs = wire.probabilities;
  if (!probs || typeof probs !== 'object') throw new Error(`${inst.def.type} answer has no probabilities`);
  const criteria = inst.def.criteria;
  if (inst.def.type === 'choice' && criteria && !Array.isArray(criteria)) {
    const undeclared = Object.keys(probs).filter(k => !Object.prototype.hasOwnProperty.call(criteria, k));
    if (undeclared.length > 0) throw new Error(`choice answer names options the question never offered: ${undeclared.join(', ')}`);
  }
  return fromProbabilities(probs, tolerance);
}

export function fromNoul(pYes: number): Distribution {
  return {
    probabilities: { yes: pYes, no: 1 - pYes },
    winner: pYes >= 0.5 ? 'yes' : 'no',
    primary_p: pYes,
    peakedness: Math.abs(2 * pYes - 1),
  };
}

export function fromProbabilities(probs: Record<string, number>, tolerance: number): Distribution {
  const entries = Object.entries(probs);
  if (entries.length === 0) throw new Error('probabilities are empty');
  let sum = 0;
  for (const [, p] of entries) {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new Error('probability outside [0, 1]');
    sum += p;
  }
  if (Math.abs(sum - 1) > tolerance) throw new Error(`probabilities sum to ${sum.toFixed(4)}, not 1`);
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  const [winner, top] = sorted[0]!;
  const second = sorted[1]?.[1] ?? 0;
  return { probabilities: probs, winner, primary_p: top, peakedness: top - second };
}
