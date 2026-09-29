/**
 * Fabric decision gate. The pipeline tests drive the real executePipeline against the
 * real orchestrator schema; only the network edges (service bindings, TypeSafe) are faked.
 * Decisions are asserted as enum members, never as snapshotted floats from jev-latest.
 */

import { describe, expect, it } from 'vitest';
import { TenantPolicy } from 'shared-authority-core';
import { executePipeline } from '../src/pipeline.js';
import {
  DECISIONS, INERT_LOCAL_HEAD, evaluatePoint, fabricPolicyFrom, instance, parseFabricMode, routeUtterance,
  type FabricContext,
} from '../src/fabric/index.js';
import { fromNoul } from '../src/fabric/client.js';
import { cwar } from '../src/fabric/router.js';
import { shipVerdict } from '../src/fabric/conjunction.js';
import { QUESTIONS } from '../src/fabric/questions.js';
import {
  AGREE, PINNED_MODEL, TYPESAFE_HOST, choice, makeDb, makeEnv, makeJev, noul, type Call,
} from './harness.js';

const policy = fabricPolicyFrom(new TenantPolicy());
const T = policy.thresholds;

const jevCalls = (log: Call[]) => log.filter(c => c.target === 'TYPESAFE');
const askedIds = (log: Call[]) =>
  jevCalls(log).flatMap(c => Object.keys((c.body as { questions: Record<string, unknown> }).questions).map(k => k.split('__')[0]));
const slips = (q: (sql: string, ...a: unknown[]) => Record<string, unknown>[], runId: string) =>
  q('SELECT * FROM fabric_slips WHERE run_id = ? ORDER BY rowid', runId);
const status = (q: (sql: string, ...a: unknown[]) => Record<string, unknown>[], runId: string) =>
  q('SELECT status, error, current_stage FROM pipeline_runs WHERE run_id = ?', runId)[0]!;
const deployed = (log: Call[]) =>
  log.some(c => c.target === 'OBSERVATORY' && c.path === '/v1/deploy' && (c.body as { dry_run?: boolean }).dry_run === false);

function expectWellFormed(rows: Record<string, unknown>[]) {
  for (const s of rows) {
    expect([...DECISIONS, 'not_a_gate']).toContain(s.cwar);
    const probs = JSON.parse(String(s.probabilities_json)) as Record<string, number>;
    const values = Object.values(probs);
    if (values.length > 0) {
      expect(Math.abs(values.reduce((a, b) => a + b, 0) - 1)).toBeLessThanOrEqual(0.01);
    }
    if (s.lane === 'jev' || s.lane === 'shadow') {
      // Every Jev slip logs a model id: the versioned id on success, the pinned id on failure.
      expect(s.model_id).toBe(PINNED_MODEL);
    }
  }
}

describe('CWAR', () => {
  it('1. Noul P(yes)=0.05 on a gating question rejects, even though peakedness is 0.90', () => {
    const d = fromNoul(0.05);
    expect(d.peakedness).toBeCloseTo(0.9, 10);
    expect(cwar(QUESTIONS.claim_supported, d, T)).toBe('reject');
    expect(cwar(QUESTIONS.entity_defined, d, T)).toBe('reject');
  });

  it('gating Noul between reject and review pauses', () => {
    expect(cwar(QUESTIONS.entity_defined, fromNoul(0.45), T)).toBe('pause_for_review');
    expect(cwar(QUESTIONS.entity_defined, fromNoul(0.9), T)).toBe('proceed');
  });

  it('deploy_route: flat auto_execute pauses; peaked auto_execute proceeds', () => {
    const flat = { probabilities: { auto_execute: 0.5, pause_for_review: 0.3, reject: 0.2 }, winner: 'auto_execute', primary_p: 0.5, peakedness: 0.2 };
    const midPeak = { ...flat, primary_p: 0.8, peakedness: 0.7 };
    const peaked = { ...flat, primary_p: 0.95, peakedness: 0.9 };
    expect(cwar(QUESTIONS.deploy_route, flat, T)).toBe('pause_for_review');
    expect(cwar(QUESTIONS.deploy_route, midPeak, T)).toBe('pause_for_review');
    expect(cwar(QUESTIONS.deploy_route, peaked, T)).toBe('proceed');
  });

  it('cure_family none proceeds (nothing to compile); flat family pauses', () => {
    const none = { probabilities: { none: 0.4, create: 0.35, update: 0.25 }, winner: 'none', primary_p: 0.4, peakedness: 0.05 };
    const flat = { ...none, winner: 'create' };
    expect(cwar(QUESTIONS.cure_family, none, T)).toBe('proceed');
    expect(cwar(QUESTIONS.cure_family, flat, T)).toBe('pause_for_review');
  });

  it('non-gating questions record not_a_gate', () => {
    expect(cwar(QUESTIONS.citation_ready, fromNoul(0.01), T)).toBe('not_a_gate');
    expect(cwar(QUESTIONS.gap_severity, fromNoul(0.5), T)).toBe('not_a_gate');
  });
});

describe('ship_verdict', () => {
  const yes = fromNoul(0.95);
  const peakedAuto = { probabilities: { auto_execute: 0.95, pause_for_review: 0.04, reject: 0.01 }, winner: 'auto_execute', primary_p: 0.95, peakedness: 0.91 };

  it('5. proof passes, forge claim is not entailed -> reject', () => {
    const v = shipVerdict({ proofPassed: true, dryRunPassed: true, claimSupported: fromNoul(0.1), entityDefined: yes, deployRoute: peakedAuto }, T);
    expect(v.decision).toBe('reject');
    expect(v.rule).toBe('2');
  });

  it('6. proof passes, entity undefined, claim entailed -> pause_for_review, not reject', () => {
    const v = shipVerdict({ proofPassed: true, dryRunPassed: true, claimSupported: yes, entityDefined: fromNoul(0.2), deployRoute: peakedAuto }, T);
    expect(v.decision).toBe('pause_for_review');
    expect(v.rule).toBe('4');
  });

  it('7. proof, claim, entity, dry run, and a peaked auto_execute agree -> proceed', () => {
    const v = shipVerdict({ proofPassed: true, dryRunPassed: true, claimSupported: yes, entityDefined: yes, deployRoute: peakedAuto }, T);
    expect(v.decision).toBe('proceed');
  });

  it('proof failure rejects before anything else', () => {
    expect(shipVerdict({ proofPassed: false, dryRunPassed: true, claimSupported: yes, entityDefined: yes, deployRoute: peakedAuto }, T).decision).toBe('reject');
  });

  it('fail closed: a missing or uncertain claim_supported cannot fall through to proceed', () => {
    expect(shipVerdict({ proofPassed: true, dryRunPassed: true, claimSupported: null, entityDefined: yes, deployRoute: peakedAuto }, T).decision).toBe('pause_for_review');
    expect(shipVerdict({ proofPassed: true, dryRunPassed: true, claimSupported: fromNoul(0.45), entityDefined: yes, deployRoute: peakedAuto }, T).decision).toBe('pause_for_review');
    expect(shipVerdict({ proofPassed: true, dryRunPassed: true, claimSupported: yes, entityDefined: yes, deployRoute: null }, T).decision).toBe('pause_for_review');
  });

  it('a failed dry run cannot proceed', () => {
    expect(shipVerdict({ proofPassed: true, dryRunPassed: false, claimSupported: yes, entityDefined: yes, deployRoute: peakedAuto }, T).decision).toBe('pause_for_review');
  });
});

describe('lanes', () => {
  async function ctxWith(log: Call[]): Promise<FabricContext> {
    const db = await makeDb();
    return {
      db: db.d1, runId: 'run_fixture_lanes', policy, localHead: INERT_LOCAL_HEAD, calibration: new Map(),
      jev: { apiKey: 'fixture_key', model: PINNED_MODEL, timeoutMs: 1000, fetch: makeJev(log, { n: 0 }), probabilitySumTolerance: 0.01 },
    };
  }

  it('3. second evaluate of the same question and content hash performs no fetch and writes lane = replay', async () => {
    const log: Call[] = [];
    const ctx = await ctxWith(log);
    const state = { tenant: { domain: 'fixture-harbor.test' } };
    const first = await evaluatePoint(ctx, 'compile_cures', state, [instance(QUESTIONS.entity_defined, 'fixture-harbor.test')]);
    expect(jevCalls(log)).toHaveLength(1);
    const second = await evaluatePoint(ctx, 'compile_cures', state, [instance(QUESTIONS.entity_defined, 'fixture-harbor.test')]);
    expect(jevCalls(log)).toHaveLength(1);
    const a1 = [...first.values()][0]!;
    const a2 = [...second.values()][0]!;
    expect(a1.lane).toBe('jev');
    expect(a2.lane).toBe('replay');
    expect(a2.dist).toEqual(a1.dist);
  });

  it('a changed state is not replayed', async () => {
    const log: Call[] = [];
    const ctx = await ctxWith(log);
    await evaluatePoint(ctx, 'compile_cures', { v: 1 }, [instance(QUESTIONS.entity_defined, 'x')]);
    await evaluatePoint(ctx, 'compile_cures', { v: 2 }, [instance(QUESTIONS.entity_defined, 'x')]);
    expect(jevCalls(log)).toHaveLength(2);
  });

  it('force-local with the inert local head fails closed and does not call Jev', async () => {
    const log: Call[] = [];
    const ctx = await ctxWith(log);
    ctx.calibration.set('entity_defined', { question_id: 'entity_defined', labels: 0, local_brier: null, jev_brier: null, mode: 'force-local' });
    const out = await evaluatePoint(ctx, 'compile_cures', { v: 1 }, [instance(QUESTIONS.entity_defined, 'x')]);
    const a = [...out.values()][0]!;
    expect(jevCalls(log)).toHaveLength(0);
    expect(a.lane).toBe('local');
    expect(a.dist).toBeNull();
    expect(a.cwar).toBe('pause_for_review');
  });

  it('auto promotes to local only with >= 12 labels and a better Brier score', async () => {
    const { pickLane } = await import('../src/fabric/router.js');
    const row = (labels: number, local: number, jev: number) => ({ question_id: 'claim_supported', labels, local_brier: local, jev_brier: jev, mode: 'auto' as const });
    expect(pickLane(QUESTIONS.claim_supported, { replayHit: false, calibration: row(11, 0.05, 0.2) }, policy)).toBe('jev');
    expect(pickLane(QUESTIONS.claim_supported, { replayHit: false, calibration: row(12, 0.196, 0.2) }, policy)).toBe('jev');
    expect(pickLane(QUESTIONS.claim_supported, { replayHit: false, calibration: row(12, 0.1, 0.2) }, policy)).toBe('local');
  });
});

describe('pipeline', () => {
  it('off: current loop, no Jev calls, no slips, compile body unchanged', async () => {
    const { env, deps, log, db, runId } = await makeEnv({ mode: 'off' });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    expect(status(db.query, runId).status).toBe('completed');
    expect(jevCalls(log)).toHaveLength(0);
    expect(slips(db.query, runId)).toHaveLength(0);
    const compile = log.find(c => c.target === 'COMPILER')!;
    for (const d of (compile.body as { diagnoses: Record<string, unknown>[] }).diagnoses) expect(d).not.toHaveProperty('cure_family');
  });

  it('shadow: one slip per question at A, B, C plus D, without changing the run', async () => {
    const { env, deps, log, db, runId } = await makeEnv({ mode: 'shadow' });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    expect(status(db.query, runId).status).toBe('completed');
    const rows = slips(db.query, runId);
    const ids = rows.map(r => r.question_id);
    expect(ids.sort()).toEqual([
      'citation_outcome', 'citation_ready', 'claim_supported', 'cure_family', 'cure_family', 'deploy_route',
      'entity_defined', 'gap_severity', 'gap_severity', 'proof_gate', 'schema_present', 'ship_verdict',
    ]);
    // Three request points, plus D.
    expect(jevCalls(log)).toHaveLength(4);
    expectWellFormed(rows);
    expect(rows.find(r => r.question_id === 'ship_verdict')!.cwar).toBe('proceed');
  });

  it('2. schema_present and proof_gate perform no fetch to api.typesafe.ai', async () => {
    const { env, deps, log, db, runId } = await makeEnv({ mode: 'shadow' });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    for (const c of jevCalls(log)) expect(c.path).toBe(`${TYPESAFE_HOST}/v1/systemone`);
    expect(askedIds(log)).not.toContain('schema_present');
    expect(askedIds(log)).not.toContain('proof_gate');
    expect(askedIds(log)).not.toContain('ship_verdict');
    for (const qid of ['schema_present', 'proof_gate']) {
      const s = slips(db.query, runId).find(r => r.question_id === qid)!;
      expect(s.lane).toBe('structural');
      expect(s.tokens).toBe(0);
      expect(s.model_id).toBeNull();
    }
  });

  it('4. cure_family winner is on the compile body, and compile is not called before the point-A Jev call', async () => {
    const { env, deps, log, runId } = await makeEnv({ mode: 'shadow' });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    const compile = log.find(c => c.target === 'COMPILER')!;
    const pointA = jevCalls(log).find(c => askedIds([c]).includes('cure_family'))!;
    expect(pointA.seq).toBeLessThan(compile.seq);
    const diags = (compile.body as { diagnoses: Array<{ cure_family?: string }> }).diagnoses;
    expect(diags).toHaveLength(2);
    for (const d of diags) expect(d.cure_family).toBe('create');
  });

  it('8. shadow: a Fabric reject does not set pipeline_runs.status to failed, and cwar_decisions match off', async () => {
    const off = await makeEnv({ mode: 'off' });
    await executePipeline(off.env, off.runId, 'tenant_fixture_01', undefined, off.deps);
    const shadow = await makeEnv({ mode: 'shadow', jev: { answers: { claim_supported: noul(0.05) } } });
    await executePipeline(shadow.env, shadow.runId, 'tenant_fixture_01', undefined, shadow.deps);

    const ship = slips(shadow.db.query, shadow.runId).find(r => r.question_id === 'ship_verdict')!;
    expect(ship.cwar).toBe('reject');
    expect(status(shadow.db.query, shadow.runId).status).toBe('completed');
    expect(deployed(shadow.log)).toBe(true);

    const cw = (q: typeof off.db.query, id: string) =>
      q('SELECT stage, confidence, decision FROM cwar_decisions WHERE run_id = ? ORDER BY rowid', id);
    expect(cw(shadow.db.query, shadow.runId)).toEqual(cw(off.db.query, off.runId));
  });

  it('gate + 5: valid hash, proof passes, unsupported forge claim -> run failed and deploy never called', async () => {
    const { env, deps, log, db, runId } = await makeEnv({ mode: 'gate', jev: { answers: { claim_supported: noul(0.05) } } });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    const s = status(db.query, runId);
    expect(s.status).toBe('failed');
    expect(String(s.error)).toContain('Fabric');
    expect(deployed(log)).toBe(false);
    expect(slips(db.query, runId).find(r => r.question_id === 'proof_gate')!.cwar).toBe('proceed');
  });

  it('gate + 6: entity undefined pauses at deploy with an AGE row; resume records operator_resumed and deploys', async () => {
    const { env, deps, log, db, runId } = await makeEnv({ mode: 'gate', jev: { answers: { entity_defined: noul(0.2) } } });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    const s = status(db.query, runId);
    expect(s.status).toBe('paused');
    expect(s.current_stage).toBe('deploy');
    expect(deployed(log)).toBe(false);
    expect(db.query('SELECT action, outcome FROM age_decisions WHERE run_id = ?', runId)).toEqual([
      { action: 'pause_for_review', outcome: 'awaiting_operator' },
    ]);

    db.raw.run("UPDATE pipeline_runs SET status = 'running' WHERE run_id = ?", [runId]);
    await executePipeline(env, runId, 'tenant_fixture_01', 'deploy', deps);
    expect(status(db.query, runId).status).toBe('completed');
    expect(deployed(log)).toBe(true);
    const resumed = slips(db.query, runId).filter(r => r.question_id === 'ship_verdict').at(-1)!;
    expect(resumed.winner).toBe('operator_resumed');
  });

  it('gate + 7: everything agrees -> deploys and completes', async () => {
    const { env, deps, log, db, runId } = await makeEnv({ mode: 'gate' });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    expect(status(db.query, runId).status).toBe('completed');
    expect(deployed(log)).toBe(true);
  });

  it('gate: today\'s forge path (cure_refs: []) fails the proof gate, so gate mode cannot deploy yet', async () => {
    const { env, deps, log, db, runId } = await makeEnv({ mode: 'gate', scenario: { cureRefs: [] } });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    expect(status(db.query, runId).status).toBe('failed');
    expect(deployed(log)).toBe(false);
    const proof = slips(db.query, runId).find(r => r.question_id === 'proof_gate')!;
    expect(proof.cwar).toBe('reject');
    expect(String(proof.detail_json)).toContain('No cure references');
  });

  it('gate: count-heuristic stage confidence is telemetry and cannot pause the run', async () => {
    const { env, deps, db, runId } = await makeEnv({ mode: 'gate', scenario: { compiled: 0 } });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    expect(status(db.query, runId).status).toBe('completed');
    const compileRow = db.query("SELECT decision FROM cwar_decisions WHERE run_id = ? AND stage = 'compile_cures'", runId)[0]!;
    expect(compileRow.decision).toBe('pause_for_review');
  });

  it('gate: cure_family none drops the diagnosis from compile', async () => {
    const none = choice({ create: 0.02, update: 0.02, optimize: 0.01, remove: 0.01, restructure: 0.01, none: 0.93 });
    const { env, deps, log, runId } = await makeEnv({ mode: 'gate', jev: { answers: { cure_family: none } } });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    const compile = log.find(c => c.target === 'COMPILER')!;
    expect((compile.body as { diagnoses: unknown[] }).diagnoses).toHaveLength(0);
  });

  it('9. citation_ready never changes pipeline status', async () => {
    const { env, deps, db, runId } = await makeEnv({
      mode: 'gate',
      jev: { answers: { citation_ready: noul(0.01), citation_outcome: choice({ cited_us: 0.01, cited_competitor: 0.01, omitted: 0.01, hallucinated_us: 0.97 }) } },
    });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    expect(status(db.query, runId).status).toBe('completed');
    const cr = slips(db.query, runId).find(r => r.question_id === 'citation_ready')!;
    expect(cr.lane).toBe('shadow');
    expect(cr.cwar).toBe('not_a_gate');
  });

  it('10. Jev HTTP 500 on gating questions -> pause_for_review, not a made-up confidence', async () => {
    const { env, deps, db, runId } = await makeEnv({ mode: 'gate', jev: { status: 500 } });
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    expect(status(db.query, runId).status).toBe('paused');
    const rows = slips(db.query, runId);
    expectWellFormed(rows);
    for (const qid of ['entity_defined', 'claim_supported', 'deploy_route']) {
      const s = rows.find(r => r.question_id === qid)!;
      expect(s.cwar).toBe('pause_for_review');
      expect(s.primary_p).toBeNull();
      expect(s.winner).toBeNull();
      expect(s.probabilities_json).toBe('{}');
      expect(String(s.detail_json)).toContain('HTTP 500');
    }
  });

  it('missing TYPESAFE_API_KEY fails closed without calling TypeSafe', async () => {
    const { env, deps, log, db, runId } = await makeEnv({ mode: 'gate' });
    env.TYPESAFE_API_KEY = undefined;
    await executePipeline(env, runId, 'tenant_fixture_01', undefined, deps);
    expect(jevCalls(log)).toHaveLength(0);
    expect(status(db.query, runId).status).toBe('paused');
  });
});

describe('FABRIC_MODE', () => {
  it('defaults to shadow; an unrecognized value runs as shadow, never off and never gate', () => {
    expect(parseFabricMode(undefined)).toBe('shadow');
    expect(parseFabricMode('')).toBe('shadow');
    expect(parseFabricMode('gaet')).toBe('shadow');
    expect(parseFabricMode('GATE')).toBe('gate');
    expect(parseFabricMode('off')).toBe('off');
  });
});

describe('routeUtterance', () => {
  const route = (answers: Record<string, ReturnType<typeof noul>> = {}, status?: number) =>
    routeUtterance('fixture_ utterance', {
      thresholds: T,
      jev: { apiKey: 'fixture_key', model: PINNED_MODEL, timeoutMs: 1000, fetch: makeJev([], { n: 0 }, { answers, status }), probabilitySumTolerance: 0.01 },
    });

  it('PII escalates and does not forward the raw text', async () => {
    const r = await route({ utterance_pii: noul(0.9) });
    expect(r.action).toBe('escalate');
    expect(r.forward_text).toBe(false);
  });

  it('high urgency escalates before the bot improvises', async () => {
    expect((await route({ utterance_urgent: noul(0.9) })).action).toBe('escalate');
  });

  it('flat intent qualifies', async () => {
    const flat = choice({ sales: 0.3, support: 0.25, scheduling: 0.2, information: 0.15, other: 0.1 });
    expect((await route({ utterance_intent: flat })).action).toBe('qualify');
  });

  it('sales intent qualifies, never answers with a price', async () => {
    const sales = choice({ sales: 0.95, support: 0.02, scheduling: 0.01, information: 0.01, other: 0.01 });
    expect((await route({ utterance_intent: sales })).action).toBe('qualify');
  });

  it('clear informational intent answers from approved copy', async () => {
    const r = await route();
    expect(r.action).toBe('answer');
    expect(r.model_id).toBe(PINNED_MODEL);
    expect(AGREE.utterance_intent).toBeDefined();
  });

  it('Jev down -> escalate, text not forwarded', async () => {
    const r = await route({}, 500);
    expect(r.action).toBe('escalate');
    expect(r.forward_text).toBe(false);
  });
});
