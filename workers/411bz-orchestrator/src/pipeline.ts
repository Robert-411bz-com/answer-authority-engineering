/**
 * Pipeline execution engine — 12 stages with CPR / CWAR / AGE.
 *
 * Fabric (FABRIC_MODE):
 *   off     current loop, unchanged.
 *   shadow  Fabric writes slips at points A-D; proceed / pause / reject are unchanged.
 *   gate    Fabric's ship_verdict is the only thing that may reject or pause the run.
 *           Count-heuristic stage confidence is still recorded in cwar_decisions as telemetry.
 */

import { TenantPolicy } from 'shared-authority-core';
import {
  INERT_LOCAL_HEAD, fabricPolicyFrom, loadCalibration, parseFabricMode,
  type CalibrationRow, type Decision, type FabricContext, type FabricMode, type LocalHead,
} from './fabric/index.js';
import {
  parseCureRefs, pointA, pointB, pointC, pointD, recordOperatorResume, steerCompile,
  type DiagnosisRow, type ForgeOutput, type PointAResult, type PointBResult, type TenantInfo,
} from './fabric/points.js';

export const STAGES = [
  'ingest', 'crawl_normalize', 'examine', 'evidence_graph',
  'diagnosis', 'compile_cures', 'forge_content', 'deploy_dry_run',
  'deploy', 'remeasure', 'compare_deltas', 'publish_scorecard',
] as const;
export type Stage = typeof STAGES[number];

export type Bindings = {
  DB: D1Database;
  ENGINE: Fetcher;
  EXAMINER: Fetcher;
  COMPILER: Fetcher;
  FORGE: Fetcher;
  OBSERVATORY: Fetcher;
  SCHEMA_ENGINE: Fetcher;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
  FABRIC_MODE?: string;
  TYPESAFE_API_KEY?: string;
  TYPESAFE_MODEL?: string;
};

type StageResult = {
  confidence: number;
  data?: unknown;
  artifacts?: unknown[];
};

export interface PipelineDeps {
  /** Outbound fetch for TypeSafe. Service bindings are not affected. */
  fetch: typeof fetch;
  localHead: LocalHead;
}

export const DEFAULT_DEPS: PipelineDeps = {
  fetch: (input, init) => fetch(input, init),
  localHead: INERT_LOCAL_HEAD,
};

const DEFAULT_TYPESAFE_MODEL = 'jev-latest';

interface PipelineFabric {
  mode: Exclude<FabricMode, 'off'>;
  ctx: FabricContext;
}

export async function executePipeline(
  env: Bindings, runId: string, tenantId: string, startFrom?: Stage, deps: PipelineDeps = DEFAULT_DEPS,
) {
  const startIdx = startFrom ? STAGES.indexOf(startFrom) : 0;
  const headers = { 'X-Authority-Key': env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' };

  // Load tenant policy for threshold resolution
  const tenantResp = await env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${tenantId}`, { headers }));
  let policy = new TenantPolicy();
  let tenant: TenantInfo = { tenant_id: tenantId };
  if (tenantResp.ok) {
    const tenantData = await tenantResp.json() as { data: { policy_overrides?: string; domain?: string; business_name?: string; business_type?: string } };
    policy = TenantPolicy.fromRow(tenantData.data || {});
    const t = tenantData.data || {};
    tenant = { tenant_id: tenantId, domain: t.domain, business_name: t.business_name, business_type: t.business_type };
  }

  // Track pre-pipeline AII for delta comparison
  let aiiBefore = 0;
  try {
    const aiiResp = await env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${tenantId}/compute-aii`, {
      method: 'POST', headers,
    }));
    if (aiiResp.ok) {
      const aiiData = await aiiResp.json() as { data: { aii: number } };
      aiiBefore = aiiData.data?.aii || 0;
    }
  } catch { /* continue with 0 */ }

  const fabric = await startFabric(env, runId, policy, deps);
  const gate = fabric?.mode === 'gate';
  const fab: { a?: PointAResult; b?: PointBResult } = {};

  // Accumulate stage outputs for cross-stage data flow
  const stageOutputs: Record<string, unknown> = { aii_before: aiiBefore };

  for (let i = startIdx; i < STAGES.length; i++) {
    const stage = STAGES[i];
    try {
      // CPR: Save checkpoint before each stage
      const checkpointId = `cp_${runId}_${stage}_${Date.now().toString(36)}`;
      await env.DB.prepare(
        'INSERT INTO cpr_checkpoints (checkpoint_id, run_id, stage, state_snapshot) VALUES (?, ?, ?, ?)'
      ).bind(checkpointId, runId, stage, JSON.stringify({
        stage_index: i, tenant_id: tenantId, outputs_so_far: Object.keys(stageOutputs),
      })).run();

      // Update current stage
      await env.DB.prepare(
        "UPDATE pipeline_runs SET current_stage = ?, updated_at = datetime('now') WHERE run_id = ?"
      ).bind(stage, runId).run();

      // Fabric point A: before compile_cures calls the compiler.
      if (fabric && stage === 'compile_cures') {
        fab.a = await guarded('A', async () => pointA(fabric.ctx, {
          tenant,
          examScore: examineOutput(stageOutputs).examScore,
          schema: examineOutput(stageOutputs).schema,
          diagnoses: await loadDiagnoses(env, tenantId, headers, stageOutputs),
          evidenceTotal: (stageOutputs['evidence_graph'] as { evidence_count?: number } | undefined)?.evidence_count ?? null,
        }));
      }

      // Fabric point C: before deploy. In gate mode, ship_verdict is the only deploy pause/reject.
      if (fabric && stage === 'deploy') {
        const ship = await fabricPointC(fabric, fab, stageOutputs, startFrom === 'deploy' && i === startIdx);
        if (gate && ship.decision !== 'proceed') {
          await applyFabricDecision(env, runId, stage, ship.decision, ship.reason, ship.confidence);
          break;
        }
      }

      // Execute stage via service binding
      const compileSteer = fab.a
        ? (diagnoses: DiagnosisRow[]) => steerCompile(diagnoses, fab.a!, gate)
        : undefined;
      const result = await executeStage(env, stage, tenantId, runId, headers, stageOutputs, compileSteer);
      stageOutputs[stage] = result.data;

      // Fabric point B: after forge returns, before the dry run.
      if (fabric && stage === 'forge_content') {
        fab.b = await guarded('B', async () => pointB(fabric.ctx, {
          forge: await loadForgeOutput(env, tenantId, headers, result.data),
          evidence: await loadEvidenceForState(env, tenantId, headers, policy.resolve('FABRIC_EVIDENCE_STATE_LIMIT')),
          contentMaxChars: policy.resolve('FABRIC_CONTENT_STATE_MAX_CHARS'),
        }));
      }

      // Fabric point D: after remeasure. Write-only; never breaks the loop.
      if (fabric && stage === 'remeasure') {
        await guarded('D', () => pointD(fabric.ctx, {
          tenant,
          published: fab.b?.forge?.content ?? null,
          deployment: stageOutputs['deploy'] ?? null,
          remeasure: { aii_before: aiiBefore, ...(result.data as object | undefined) },
        }));
      }

      // CWAR: Route based on confidence using tenant-resolved thresholds
      const confidence = result.confidence;
      const rejectThreshold = policy.resolve('CONFIDENCE_THRESHOLD_REJECT');
      const reviewThreshold = policy.resolve('CONFIDENCE_THRESHOLD_REVIEW');

      let decision = 'proceed';
      if (confidence < rejectThreshold) {
        decision = 'reject';
      } else if (confidence < reviewThreshold) {
        decision = 'pause_for_review';
      }

      // Record CWAR decision (in gate mode this is telemetry; it does not route the run)
      await env.DB.prepare(
        'INSERT INTO cwar_decisions (decision_id, run_id, stage, confidence, reject_threshold, review_threshold, decision, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))'
      ).bind(`cwar_${runId}_${stage}`, runId, stage, confidence, rejectThreshold, reviewThreshold, decision).run();

      if (!gate) {
        if (decision === 'reject') {
          await env.DB.prepare('UPDATE pipeline_runs SET status = ?, error = ? WHERE run_id = ?')
            .bind('failed', `Stage ${stage} rejected: confidence ${confidence} < ${rejectThreshold}`, runId).run();
          break;
        } else if (decision === 'pause_for_review') {
          await env.DB.prepare('UPDATE pipeline_runs SET status = ? WHERE run_id = ?').bind('paused', runId).run();
          // AGE decision
          await env.DB.prepare(
            'INSERT INTO age_decisions (decision_id, run_id, stage, action, confidence, outcome) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(`age_${runId}_${stage}`, runId, stage, 'pause_for_review', confidence, 'awaiting_operator').run();
          break;
        }
      }

      // Record transition
      const nextStage = i + 1 < STAGES.length ? STAGES[i + 1] : 'completed';
      await env.DB.prepare(
        'INSERT INTO stage_transitions (run_id, from_stage, to_stage, confidence, decision) VALUES (?, ?, ?, ?, ?)'
      ).bind(runId, stage, nextStage, confidence, gate ? 'proceed' : decision).run();

    } catch (err) {
      await env.DB.prepare('UPDATE pipeline_runs SET status = ?, error = ? WHERE run_id = ?')
        .bind('failed', (err as Error).message, runId).run();
      return;
    }
  }

  // Mark completed if we reached the end
  const finalRun = await env.DB.prepare('SELECT status FROM pipeline_runs WHERE run_id = ?').bind(runId).first<{ status: string }>();
  if (finalRun?.status === 'running') {
    await env.DB.prepare(
      "UPDATE pipeline_runs SET status = ?, current_stage = ?, completed_at = datetime('now') WHERE run_id = ?"
    ).bind('completed', 'publish_scorecard', runId).run();
  }
}

// ── Fabric wiring ──

async function startFabric(env: Bindings, runId: string, policy: TenantPolicy, deps: PipelineDeps): Promise<PipelineFabric | null> {
  const mode = parseFabricMode(env.FABRIC_MODE);
  if (mode === 'off') return null;
  const fabricPolicy = fabricPolicyFrom(policy);
  let calibration = new Map<string, CalibrationRow>();
  try {
    calibration = await loadCalibration(env.DB);
  } catch (err) {
    // Table missing (schema not applied): every semantic question takes the jev lane.
    console.error('fabric: calibration unavailable', err);
  }
  return {
    mode,
    ctx: {
      db: env.DB,
      runId,
      policy: fabricPolicy,
      jev: {
        apiKey: env.TYPESAFE_API_KEY,
        model: env.TYPESAFE_MODEL || DEFAULT_TYPESAFE_MODEL,
        timeoutMs: fabricPolicy.jevTimeoutMs,
        fetch: deps.fetch,
        probabilitySumTolerance: fabricPolicy.probabilitySumTolerance,
      },
      localHead: deps.localHead,
      calibration,
    },
  };
}

/** Fabric points A, B, D never break the loop. A failure leaves their inputs to C missing, and C fails closed. */
async function guarded<T>(point: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.error(`fabric: point ${point} failed`, err);
    return undefined;
  }
}

async function fabricPointC(
  fabric: PipelineFabric, fab: { a?: PointAResult; b?: PointBResult },
  stageOutputs: Record<string, unknown>, resumedAtDeploy: boolean,
): Promise<{ decision: Decision; reason: string; confidence: number }> {
  try {
    if (resumedAtDeploy) {
      await recordOperatorResume(fabric.ctx);
      return { decision: 'proceed', reason: 'operator resumed', confidence: 1 };
    }
    const c = await pointC(fabric.ctx, {
      b: fab.b ?? null,
      entityDefined: fab.a?.entityDefined ?? null,
      dryRun: (stageOutputs['deploy_dry_run'] as { verdict?: string } | null | undefined) ?? null,
    });
    return {
      decision: c.decision,
      reason: `ship_verdict rule ${c.rule}: ${c.reason}`,
      confidence: c.deployRoute?.peakedness ?? 0,
    };
  } catch (err) {
    console.error('fabric: point C failed', err);
    return { decision: 'pause_for_review', reason: `Fabric point C failed: ${(err as Error).message}`, confidence: 0 };
  }
}

/** Map a Fabric decision onto the existing statuses. No fourth status. */
async function applyFabricDecision(
  env: Bindings, runId: string, stage: Stage, decision: Exclude<Decision, 'proceed'>, reason: string, confidence: number,
) {
  if (decision === 'reject') {
    await env.DB.prepare('UPDATE pipeline_runs SET status = ?, error = ? WHERE run_id = ?')
      .bind('failed', `Fabric ${reason}`, runId).run();
    return;
  }
  await env.DB.prepare('UPDATE pipeline_runs SET status = ? WHERE run_id = ?').bind('paused', runId).run();
  await env.DB.prepare(
    'INSERT INTO age_decisions (decision_id, run_id, stage, action, confidence, outcome) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(`age_${runId}_${stage}`, runId, stage, 'pause_for_review', confidence, 'awaiting_operator').run();
}

function examineOutput(stageOutputs: Record<string, unknown>) {
  const ex = stageOutputs['examine'] as { exam?: { overall_score?: number }; schema?: unknown } | undefined;
  return {
    examScore: typeof ex?.exam?.overall_score === 'number' ? ex.exam.overall_score : null,
    schema: (ex?.schema ?? null) as Parameters<typeof pointA>[1]['schema'],
  };
}

async function loadDiagnoses(
  env: Bindings, tenantId: string, headers: Record<string, string>, stageOutputs: Record<string, unknown>,
): Promise<DiagnosisRow[]> {
  const diagOutput = stageOutputs['diagnosis'] as { diagnoses?: unknown[] } | undefined;
  if (diagOutput?.diagnoses) return diagOutput.diagnoses as DiagnosisRow[];
  const resp = await env.ENGINE.fetch(new Request(
    `http://internal/v1/tenants/${tenantId}/diagnoses`, { headers }
  ));
  if (!resp.ok) return [];
  const data = await resp.json() as { data: unknown[] };
  return (data.data || []) as DiagnosisRow[];
}

/** forge /v1/generate returns ids only; the content lives on the engine's artifact row. */
async function loadForgeOutput(
  env: Bindings, tenantId: string, headers: Record<string, string>, forgeData: unknown,
): Promise<ForgeOutput | null> {
  const env_ = forgeData as { data?: { artifact_id?: string; content_hash?: string; surface_kind?: string } } | null;
  const artifactId = env_?.data?.artifact_id;
  if (!artifactId) return null;
  const resp = await env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${tenantId}/artifacts`, { headers }));
  const rows = resp.ok ? ((await resp.json() as { data?: unknown[] }).data || []) : [];
  const row = rows.find(r => (r as { artifact_id?: string }).artifact_id === artifactId) as
    { content?: string; content_hash?: string; kind?: string; cure_refs?: unknown } | undefined;
  return {
    artifact_id: artifactId,
    content_hash: row?.content_hash ?? env_?.data?.content_hash ?? null,
    kind: row?.kind ?? env_?.data?.surface_kind ?? null,
    content: row?.content ?? null,
    cure_refs: parseCureRefs(row?.cure_refs),
  };
}

async function loadEvidenceForState(
  env: Bindings, tenantId: string, headers: Record<string, string>, limit: number,
): Promise<unknown[]> {
  const resp = await env.ENGINE.fetch(new Request(
    `http://internal/v1/tenants/${tenantId}/evidence?limit=${limit}`, { headers }
  ));
  if (!resp.ok) return [];
  const data = await resp.json() as { data?: { items?: Array<Record<string, unknown>> } };
  return (data.data?.items || []).map(e => ({
    evidence_id: e.evidence_id, source_type: e.source_type, source_url: e.source_url, metadata: e.metadata,
  }));
}

// ── Stage executors ──

async function executeStage(
  env: Bindings, stage: Stage, tenantId: string, runId: string,
  headers: Record<string, string>, stageOutputs: Record<string, unknown>,
  compileSteer?: (diagnoses: DiagnosisRow[]) => unknown[],
): Promise<StageResult> {
  switch (stage) {
    case 'ingest': {
      const resp = await env.ENGINE.fetch(new Request('http://internal/v1/connectors/ingest', {
        method: 'POST', headers, body: JSON.stringify({ tenant_id: tenantId }),
      }));
      const data = resp.ok ? await resp.json() : null;
      const connectorCount = (data as { data?: { connector_results?: unknown[] } })?.data?.connector_results?.length || 0;
      return { confidence: connectorCount > 0 ? 0.9 : 0.7, data };
    }

    case 'crawl_normalize': {
      const resp = await env.OBSERVATORY.fetch(new Request('http://internal/v1/probe', {
        method: 'POST', headers, body: JSON.stringify({ tenant_id: tenantId }),
      }));
      const data = resp.ok ? await resp.json() : null;
      const probes = (data as { data?: { probes?: Array<{ status: number }> } })?.data?.probes || [];
      const reachable = probes.filter(p => p.status >= 200 && p.status < 400).length;
      const confidence = probes.length > 0 ? reachable / probes.length : 0.3;
      return { confidence, data };
    }

    case 'examine': {
      // Run both authority examiner and schema engine examine in parallel
      const [examResp, schemaResp] = await Promise.all([
        env.EXAMINER.fetch(new Request('http://internal/v1/examine', {
          method: 'POST', headers, body: JSON.stringify({ tenant_id: tenantId }),
        })),
        env.SCHEMA_ENGINE.fetch(new Request('http://internal/v1/examine', {
          method: 'POST', headers, body: JSON.stringify({ tenant_id: tenantId }),
        })),
      ]);
      const examData = examResp.ok ? await examResp.json() as { data: { overall_score: number; diagnoses: unknown[] } } : null;
      const schemaData = schemaResp.ok ? await schemaResp.json() as { data: { schema_health_score: number } } : null;

      // Persist diagnoses from examiner to engine
      const diagnoses = examData?.data?.diagnoses || [];
      if (diagnoses.length > 0) {
        await env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${tenantId}/diagnoses/batch`, {
          method: 'POST', headers, body: JSON.stringify({ diagnoses }),
        }));
      }

      const examScore = examData?.data?.overall_score || 0;
      const schemaScore = schemaData?.data?.schema_health_score || 0;
      const combinedConfidence = (examScore * 0.7 + schemaScore * 0.3);
      return { confidence: combinedConfidence, data: { exam: examData?.data, schema: schemaData?.data } };
    }

    case 'evidence_graph': {
      // Fetch evidence and compute graph density
      const resp = await env.ENGINE.fetch(new Request(
        `http://internal/v1/tenants/${tenantId}/evidence?limit=500`, { headers }
      ));
      const data = resp.ok ? await resp.json() as { data: { items: unknown[]; total: number } } : null;
      const evidenceCount = data?.data?.total || 0;
      const confidence = Math.min(0.95, 0.3 + evidenceCount * 0.01);
      return { confidence, data: { evidence_count: evidenceCount } };
    }

    case 'diagnosis': {
      // Fetch persisted diagnoses
      const resp = await env.ENGINE.fetch(new Request(
        `http://internal/v1/tenants/${tenantId}/diagnoses`, { headers }
      ));
      const data = resp.ok ? await resp.json() as { data: unknown[] } : null;
      const diagCount = (data?.data || []).length;
      const confidence = diagCount > 0 ? 0.85 : 0.5;
      return { confidence, data: { diagnosis_count: diagCount, diagnoses: data?.data } };
    }

    case 'compile_cures': {
      // Get diagnoses from previous stage output or fetch
      const diagnoses = await loadDiagnoses(env, tenantId, headers, stageOutputs);

      const resp = await env.COMPILER.fetch(new Request('http://internal/v1/compile', {
        method: 'POST', headers,
        body: JSON.stringify({ tenant_id: tenantId, diagnoses: compileSteer ? compileSteer(diagnoses) : diagnoses }),
      }));
      const data = resp.ok ? await resp.json() as { data: { compiled: number; errors: number } } : null;
      const compiled = data?.data?.compiled || 0;
      const errors = data?.data?.errors || 0;
      const confidence = compiled > 0 ? Math.min(0.95, 0.6 + compiled * 0.05 - errors * 0.1) : 0.4;
      return { confidence, data: data?.data };
    }

    case 'forge_content': {
      const resp = await env.FORGE.fetch(new Request('http://internal/v1/generate', {
        method: 'POST', headers,
        body: JSON.stringify({
          tenant_id: tenantId,
          kind: 'cure_action',
          topic: `Authority content for pipeline run ${runId}`,
          cure_refs: [],
        }),
      }));
      const data = resp.ok ? await resp.json() : null;
      return { confidence: resp.ok ? 0.8 : 0.5, data };
    }

    case 'deploy_dry_run': {
      const resp = await env.OBSERVATORY.fetch(new Request('http://internal/v1/deploy', {
        method: 'POST', headers,
        body: JSON.stringify({ tenant_id: tenantId, run_id: runId, dry_run: true }),
      }));
      const data = resp.ok ? await resp.json() as { data: { verdict: string } } : null;
      const passed = data?.data?.verdict === 'dry_run_passed';
      return { confidence: passed ? 0.9 : 0.4, data: data?.data };
    }

    case 'deploy': {
      const resp = await env.OBSERVATORY.fetch(new Request('http://internal/v1/deploy', {
        method: 'POST', headers,
        body: JSON.stringify({ tenant_id: tenantId, run_id: runId, dry_run: false }),
      }));
      const data = resp.ok ? await resp.json() as { data: { verdict: string } } : null;
      const deployed = data?.data?.verdict === 'deployed';
      return { confidence: deployed ? 0.85 : 0.4, data: data?.data };
    }

    case 'remeasure': {
      // Re-compute AII after deployment
      const resp = await env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${tenantId}/compute-aii`, {
        method: 'POST', headers,
      }));
      const data = resp.ok ? await resp.json() as { data: { aii: number } } : null;
      const aii = data?.data?.aii || 0;
      return { confidence: aii > 0 ? 0.9 : 0.5, data: { aii_after: aii } };
    }

    case 'compare_deltas': {
      const aiiBefore = (stageOutputs['aii_before'] as number) || 0;
      const remeasure = stageOutputs['remeasure'] as { aii_after?: number } | undefined;
      const aiiAfter = remeasure?.aii_after || 0;
      const delta = aiiAfter - aiiBefore;
      const improved = delta > 0;
      return { confidence: improved ? 0.9 : 0.6, data: { aii_before: aiiBefore, aii_after: aiiAfter, delta } };
    }

    case 'publish_scorecard': {
      const remeasure = stageOutputs['remeasure'] as { aii_after?: number } | undefined;
      const deltas = stageOutputs['compare_deltas'] as { aii_before?: number; aii_after?: number } | undefined;
      const resp = await env.ENGINE.fetch(new Request('http://internal/v1/scorecard/publish', {
        method: 'POST', headers,
        body: JSON.stringify({
          tenant_id: tenantId,
          run_id: runId,
          aii_before: deltas?.aii_before || 0,
          aii_after: remeasure?.aii_after || deltas?.aii_after || 0,
        }),
      }));
      const data = resp.ok ? await resp.json() : null;
      return { confidence: resp.ok ? 1.0 : 0.5, data };
    }

    default:
      return { confidence: 0 };
  }
}
