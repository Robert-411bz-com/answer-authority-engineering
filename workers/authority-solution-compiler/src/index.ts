/**
 * authority-solution-compiler — SOLE cure compiler.
 * No other worker creates cure objects. All cures trace to evidence.
 *
 * All thresholds (impact baselines, priority values, confidence scaling)
 * are resolved via TenantPolicy — no magic numbers in this file.
 */

import { Hono } from 'hono';
import {
  assertTenantId, createCureId, validateCure, type CureAction,
  wrapTruth, generateRequestId, POLICY_DEFAULTS, CANONICAL_WORKERS,
  TenantPolicy,
} from 'shared-authority-core';

type Bindings = {
  ENGINE: Fetcher;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('/v1/*', async (c, next) => {
  const key = c.req.header('X-Authority-Key');
  if (key !== c.env.AUTHORITY_INTERNAL_KEY) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

app.post('/v1/compile', async (c) => {
  const body = await c.req.json<{
    tenant_id: string;
    diagnoses: Array<{
      diagnosis_id: string; category: string; severity: string;
      description: string; evidence_ids: string[];
      /** Fabric point-A winner; one of CureAction['action_type'] or 'none'. */
      cure_family?: string;
    }>;
    /** Only when true does cure_family choose the action type. Fabric sets it in gate mode only. */
    steer_cure_family?: boolean;
  }>();
  assertTenantId(body.tenant_id);

  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' };

  // Load tenant policy for threshold resolution
  const tenantResp = await c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}`, { headers }));
  let policy = new TenantPolicy();
  if (tenantResp.ok) {
    const tenantData = await tenantResp.json() as { data: { policy_overrides?: string } };
    policy = TenantPolicy.fromRow(tenantData.data || {});
  }

  const cures: CureAction[] = [];
  const errors: string[] = [];
  const steer = body.steer_cure_family === true;
  let steered = 0;
  let skippedNone = 0;

  for (const diag of body.diagnoses) {
    if (!diag.evidence_ids || diag.evidence_ids.length === 0) {
      errors.push(`Diagnosis ${diag.diagnosis_id} has no evidence — cannot compile cure`);
      continue;
    }
    if (steer && diag.cure_family === 'none') {
      skippedNone++;
      continue;
    }
    const steeredAction = steer ? asActionType(diag.cure_family) : null;
    if (steeredAction) steered++;

    const cure: CureAction = {
      cure_id: createCureId(body.tenant_id, diag.category),
      tenant_id: body.tenant_id,
      diagnosis_id: diag.diagnosis_id,
      category: diag.category,
      action_type: steeredAction ?? mapSeverityToAction(diag.severity),
      target: diag.category,
      instructions: generateInstructions(diag),
      evidence_ids: diag.evidence_ids,
      priority: mapSeverityToPriority(diag.severity, policy),
      estimated_impact: estimateImpact(diag.severity, diag.evidence_ids.length, policy),
      confidence: computeCureConfidence(diag.evidence_ids.length, policy),
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    const validation = validateCure(cure);
    if (validation.length > 0) {
      errors.push(`Cure validation failed for ${diag.diagnosis_id}: ${validation.join(', ')}`);
      continue;
    }

    cures.push(cure);
  }

  // Persist cures to engine via service binding
  if (cures.length > 0) {
    await c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}/cures/batch`, {
      method: 'POST', headers, body: JSON.stringify({ cures }),
    }));
  }

  return c.json(wrapTruth(
    {
      compiled: cures.length, errors: errors.length, cure_ids: cures.map(cu => cu.cure_id), error_details: errors,
      steered, skipped_none: skippedNone,
    },
    c.env.WORKER_ID, generateRequestId()
  ));
});

const ACTION_TYPES: readonly CureAction['action_type'][] = ['create', 'update', 'optimize', 'remove', 'restructure'];

/** A valid steering value, or null so the severity mapping decides. */
function asActionType(family: string | undefined): CureAction['action_type'] | null {
  return family && (ACTION_TYPES as readonly string[]).includes(family) ? family as CureAction['action_type'] : null;
}

function mapSeverityToAction(severity: string): CureAction['action_type'] {
  switch (severity) {
    case 'critical': return 'create';
    case 'high': return 'restructure';
    case 'medium': return 'optimize';
    case 'low': return 'update';
    default: return 'optimize';
  }
}

function mapSeverityToPriority(severity: string, policy: TenantPolicy): number {
  switch (severity) {
    case 'critical': return policy.resolve('CURE_PRIORITY_CRITICAL');
    case 'high': return policy.resolve('CURE_PRIORITY_HIGH');
    case 'medium': return policy.resolve('CURE_PRIORITY_MEDIUM');
    case 'low': return policy.resolve('CURE_PRIORITY_LOW');
    default: return policy.resolve('CURE_PRIORITY_LOW');
  }
}

function estimateImpact(severity: string, evidenceCount: number, policy: TenantPolicy): number {
  let base: number;
  switch (severity) {
    case 'critical': base = policy.resolve('CURE_IMPACT_CRITICAL'); break;
    case 'high': base = policy.resolve('CURE_IMPACT_HIGH'); break;
    case 'medium': base = policy.resolve('CURE_IMPACT_MEDIUM'); break;
    case 'low': base = policy.resolve('CURE_IMPACT_LOW'); break;
    default: base = policy.resolve('CURE_IMPACT_LOW');
  }
  const maxBoost = policy.resolve('CURE_IMPACT_MAX_BOOST');
  const perEvidence = policy.resolve('CURE_IMPACT_EVIDENCE_BOOST');
  const evidenceBoost = Math.min(maxBoost, evidenceCount * perEvidence);
  return Math.min(1.0, base + evidenceBoost);
}

function computeCureConfidence(evidenceCount: number, policy: TenantPolicy): number {
  const base = policy.resolve('CURE_CONFIDENCE_BASE');
  const perEvidence = policy.resolve('CURE_CONFIDENCE_PER_EVIDENCE');
  const max = policy.resolve('CURE_CONFIDENCE_MAX');
  return Math.min(max, base + evidenceCount * perEvidence);
}

function generateInstructions(diag: { category: string; severity: string; description: string }): string {
  return `[${diag.severity.toUpperCase()}] ${diag.category}: ${diag.description}. Evidence-backed cure compiled from ${diag.category} analysis.`;
}

export default app;
