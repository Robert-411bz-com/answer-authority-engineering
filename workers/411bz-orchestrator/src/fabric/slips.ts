/**
 * Slip writes. One slip per question per evaluation, whatever the lane.
 */

import type { CalibrationMode, CalibrationRow, Cwar, Distribution, Lane } from './types.js';

export interface Slip {
  slip_id: string;
  run_id: string;
  stage: string;
  question_id: string;
  /** What the question was about: a tenant domain, a diagnosis id. */
  subject: string | null;
  content_hash: string | null;
  lane: Lane;
  dist: Distribution | null;
  cwar: Cwar;
  tokens: number;
  model_id: string | null;
  /** Structural checks, conjunction rule, error text, shadow local-head score. */
  detail: Record<string, unknown> | null;
}

export function newSlipId(runId: string, questionId: string): string {
  return `slip_${runId}_${questionId}_${crypto.randomUUID().slice(0, 8)}`;
}

export async function writeSlip(db: D1Database, s: Slip): Promise<void> {
  await db.prepare(
    `INSERT INTO fabric_slips (slip_id, run_id, stage, question_id, subject, content_hash, lane, winner,
     primary_p, peakedness, probabilities_json, cwar, tokens, model_id, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    s.slip_id, s.run_id, s.stage, s.question_id, s.subject, s.content_hash, s.lane,
    s.dist?.winner ?? null, s.dist?.primary_p ?? null, s.dist?.peakedness ?? null,
    JSON.stringify(s.dist?.probabilities ?? {}), s.cwar, s.tokens, s.model_id,
    s.detail ? JSON.stringify(s.detail) : null,
  ).run();
}

export async function loadCalibration(db: D1Database): Promise<Map<string, CalibrationRow>> {
  const rows = await db.prepare(
    'SELECT question_id, labels, local_brier, jev_brier, mode FROM fabric_calibration'
  ).all<{ question_id: string; labels: number; local_brier: number | null; jev_brier: number | null; mode: string }>();
  const map = new Map<string, CalibrationRow>();
  for (const r of rows.results || []) {
    map.set(r.question_id, { ...r, mode: r.mode as CalibrationMode });
  }
  return map;
}
