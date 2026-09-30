/**
 * The orchestrator's Fabric request points. State is the stage outputs the orchestrator
 * already holds, trimmed; instructions point at its fields. The whole crawl is never sent.
 *
 *   A  after diagnosis, before compile_cures    entity_defined, gap_severity, cure_family (+ schema_present)
 *   B  after forge_content, before dry run      claim_supported
 *   C  after deploy_dry_run, before deploy      proof_gate (structural), deploy_route, ship_verdict
 *   D  after remeasure, write-only              citation_ready, citation_outcome
 */

import { createDeploymentChecks, evaluateDeployment, validateContentHash } from 'shared-authority-core';
import {
  QUESTIONS, evaluatePoint, instance, recordConjunction, recordStructural, recordUnanswered, shipVerdict,
  type Answer, type FabricContext, type ShipVerdict,
} from './index.js';
import type { Distribution } from './types.js';

export interface TenantInfo {
  tenant_id: string;
  domain?: string;
  business_name?: string;
  business_type?: string;
}

export interface DiagnosisRow {
  diagnosis_id: string;
  category: string;
  severity: string;
  description: string;
  evidence_ids?: string[] | string;
}

interface SchemaExam {
  surfaces_present?: number;
  surfaces_total?: number;
  findings?: Array<{ surface: string; severity: string; description: string }>;
}

const SCHEMA_JSON_SURFACE = '/.well-known/schema.json';

// ── Point A ──

export interface PointAResult {
  entityDefined: Distribution | null;
  /** diagnosis_id -> cure_family answer */
  cureFamily: Map<string, Answer>;
}

export async function pointA(
  ctx: FabricContext,
  input: { tenant: TenantInfo; examScore: number | null; schema: SchemaExam | null; diagnoses: DiagnosisRow[]; evidenceTotal: number | null },
): Promise<PointAResult> {
  const stage = 'compile_cures';
  const subject = input.tenant.domain ?? input.tenant.tenant_id;

  // schema_present: structural, from the schema engine's own finding. Zero tokens.
  const schemaFound = input.schema !== null &&
    !(input.schema.findings || []).some(f => f.surface === SCHEMA_JSON_SURFACE);
  await recordStructural(ctx, stage, QUESTIONS.schema_present, subject, schemaFound, {
    source: 'schema_engine.findings', schema_exam_present: input.schema !== null,
  });

  const diagnoses: Record<string, unknown> = {};
  for (const d of input.diagnoses) {
    diagnoses[d.diagnosis_id] = {
      category: d.category, severity: d.severity, description: d.description,
      evidence_count: evidenceIds(d).length,
    };
  }
  const state = {
    tenant: { business_name: input.tenant.business_name ?? null, domain: input.tenant.domain ?? null, business_type: input.tenant.business_type ?? null },
    site: {
      exam_overall_score: input.examScore,
      schema_surfaces_present: input.schema?.surfaces_present ?? null,
      schema_surfaces_total: input.schema?.surfaces_total ?? null,
      schema_findings: (input.schema?.findings || []).map(f => ({ surface: f.surface, severity: f.severity, description: f.description })),
    },
    diagnoses,
    evidence_summary: { total: input.evidenceTotal },
  };

  const entityInst = instance(QUESTIONS.entity_defined, subject);
  const familyInsts = input.diagnoses.map(d => instance(QUESTIONS.cure_family, d.diagnosis_id));
  const severityInsts = input.diagnoses.map(d => instance(QUESTIONS.gap_severity, d.diagnosis_id));
  const answers = await evaluatePoint(ctx, stage, state, [entityInst, ...familyInsts, ...severityInsts]);

  const cureFamily = new Map<string, Answer>();
  for (const inst of familyInsts) {
    const a = answers.get(inst.key);
    if (a && inst.subject) cureFamily.set(inst.subject, a);
  }
  return { entityDefined: answers.get(entityInst.key)?.dist ?? null, cureFamily };
}

/**
 * Attach the winning cure_family to each diagnosis in the compile body. ASC uses it as
 * the cure's action type only when the body also carries steer_cure_family: true, which
 * the pipeline sends in gate mode only. In gate mode a `none` winner also drops the
 * diagnosis here; in shadow the diagnosis list and ASC's output are unchanged.
 */
export function steerCompile(diagnoses: DiagnosisRow[], a: PointAResult, gate: boolean): Array<DiagnosisRow & { cure_family?: string }> {
  const out: Array<DiagnosisRow & { cure_family?: string }> = [];
  for (const d of diagnoses) {
    const winner = a.cureFamily.get(d.diagnosis_id)?.dist?.winner;
    if (gate && winner === 'none') continue;
    out.push(winner ? { ...d, cure_family: winner } : d);
  }
  return out;
}

// ── Point B ──

export interface ForgeOutput {
  artifact_id: string;
  content_hash: string | null;
  kind: string | null;
  content: string | null;
  cure_refs: string[];
}

export interface PointBResult {
  claimSupported: Distribution | null;
  forge: ForgeOutput | null;
}

export async function pointB(
  ctx: FabricContext,
  input: { forge: ForgeOutput | null; evidence: unknown[]; contentMaxChars: number },
): Promise<PointBResult> {
  const stage = 'forge_content';
  const inst = instance(QUESTIONS.claim_supported, input.forge?.artifact_id ?? null);
  const missing = !input.forge ? 'forge produced no artifact'
    : !input.forge.content ? 'forge artifact has no content to check'
    : input.evidence.length === 0 ? 'no hash-verified evidence text to check against'
    : null;
  if (missing) {
    await recordUnanswered(ctx, stage, inst, missing);
    return { claimSupported: null, forge: input.forge };
  }
  const forge = input.forge!;
  const state = {
    forge_output: { artifact_id: forge.artifact_id, kind: forge.kind, content: forge.content!.slice(0, input.contentMaxChars) },
    evidence: input.evidence,
  };
  const answers = await evaluatePoint(ctx, stage, state, [inst]);
  return { claimSupported: answers.get(inst.key)?.dist ?? null, forge };
}

// ── Point C ──

export interface PointCResult extends ShipVerdict {
  slip_id: string;
  proofPassed: boolean;
  deployRoute: Distribution | null;
}

export async function pointC(
  ctx: FabricContext,
  input: { b: PointBResult | null; entityDefined: Distribution | null; dryRun: { verdict?: string } | null },
): Promise<PointCResult> {
  const stage = 'deploy';
  const forge = input.b?.forge ?? null;

  // proof_gate: structural, from the existing deployment governor's checks. Never Jev.
  const hasContentHash = !!forge?.content_hash && validateContentHash(forge.content_hash);
  const proofGatePassed = !!forge; // forge only returns an artifact after enforceProofGate passes
  const cureRefsPresent = (forge?.cure_refs.length ?? 0) > 0;
  const proofPassed = hasContentHash && proofGatePassed && cureRefsPresent;
  const proofChecks = createDeploymentChecks({ hasContentHash, proofGatePassed, confidenceAboveThreshold: true, cureRefsPresent })
    .filter(c => c.name !== 'confidence_threshold');
  await recordStructural(ctx, stage, QUESTIONS.proof_gate, forge?.artifact_id ?? null, proofPassed, { checks: proofChecks });

  const dryRunPassed = input.dryRun?.verdict === 'dry_run_passed';
  const state = {
    dry_run: input.dryRun,
    deployment_checks: proofChecks,
    forge_output: forge ? { artifact_id: forge.artifact_id, kind: forge.kind, content: forge.content } : null,
  };
  const routeInst = instance(QUESTIONS.deploy_route);
  const answers = await evaluatePoint(ctx, stage, state, [routeInst]);
  const deployRoute = answers.get(routeInst.key)?.dist ?? null;

  const verdict = shipVerdict({
    proofPassed, dryRunPassed,
    claimSupported: input.b?.claimSupported ?? null,
    entityDefined: input.entityDefined,
    deployRoute,
  }, ctx.policy.thresholds);

  // The governor's confidence_threshold check is now the ship verdict.
  const governor = evaluateDeployment(createDeploymentChecks({
    hasContentHash, proofGatePassed, cureRefsPresent, confidenceAboveThreshold: verdict.decision === 'proceed',
  }));
  const slip_id = await recordConjunction(ctx, stage, verdict.decision, verdict.decision, {
    rule: verdict.rule, reason: verdict.reason, dry_run_passed: dryRunPassed, governor,
  });
  return { ...verdict, slip_id, proofPassed, deployRoute };
}

/** A run resumed at deploy after a Fabric pause: the operator was the reviewer. */
export async function recordOperatorResume(ctx: FabricContext): Promise<string> {
  return recordConjunction(ctx, 'deploy', 'operator_resumed', 'proceed', {
    reason: 'run resumed at deploy after pause_for_review; the operator is the reviewer',
  });
}

// ── Point D ──

export async function pointD(
  ctx: FabricContext,
  input: { tenant: TenantInfo; published: string | null; deployment: unknown; remeasure: unknown },
): Promise<void> {
  const subject = input.tenant.domain ?? input.tenant.tenant_id;
  const state = {
    tenant: { business_name: input.tenant.business_name ?? null, domain: input.tenant.domain ?? null, business_type: input.tenant.business_type ?? null },
    published: input.published,
    deployment: input.deployment,
    remeasure: input.remeasure,
  };
  await evaluatePoint(ctx, 'remeasure', state, [
    instance(QUESTIONS.citation_ready, subject),
    instance(QUESTIONS.citation_outcome, subject),
  ]);
}

// ── helpers ──

function evidenceIds(d: DiagnosisRow): string[] {
  if (Array.isArray(d.evidence_ids)) return d.evidence_ids;
  if (typeof d.evidence_ids === 'string') {
    try {
      const parsed = JSON.parse(d.evidence_ids);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseCureRefs(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}
