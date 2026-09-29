/**
 * Replay: same question id + same content hash -> the stored distribution, zero tokens.
 */

import { computeContentHash } from 'shared-authority-core';
import type { QuestionInstance } from './questions.js';
import type { Distribution } from './types.js';

/** Deterministic JSON: object keys sorted at every depth. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * The hash covers the state and the question as asked (type, instructions, criteria),
 * so rewording a question never replays an answer to the old wording.
 */
export async function contentHashFor(stateJson: string, inst: QuestionInstance): Promise<string> {
  return computeContentHash(stableStringify({
    state: stateJson,
    question: { type: inst.def.type, instructions: inst.instructions, criteria: inst.def.criteria ?? null },
  }));
}

export function replayKey(questionId: string, contentHash: string): string {
  return `${questionId}:${contentHash}`;
}

export interface ReplayHit {
  dist: Distribution;
  source_slip_id: string;
}

export async function lookupReplay(db: D1Database, questionId: string, contentHash: string): Promise<ReplayHit | null> {
  const row = await db.prepare(
    'SELECT probabilities_json, winner, primary_p, peakedness, source_slip_id FROM fabric_replay WHERE replay_key = ?'
  ).bind(replayKey(questionId, contentHash)).first<{
    probabilities_json: string; winner: string; primary_p: number; peakedness: number; source_slip_id: string;
  }>();
  if (!row) return null;
  return {
    dist: {
      probabilities: JSON.parse(row.probabilities_json) as Record<string, number>,
      winner: row.winner,
      primary_p: row.primary_p,
      peakedness: row.peakedness,
    },
    source_slip_id: row.source_slip_id,
  };
}

/** First writer wins; a later identical question replays the original slip's answer. */
export async function storeReplay(
  db: D1Database, questionId: string, contentHash: string, dist: Distribution, sourceSlipId: string,
): Promise<void> {
  await db.prepare(
    'INSERT OR IGNORE INTO fabric_replay (replay_key, probabilities_json, winner, primary_p, peakedness, source_slip_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    replayKey(questionId, contentHash), JSON.stringify(dist.probabilities),
    dist.winner, dist.primary_p, dist.peakedness, sourceSlipId,
  ).run();
}
