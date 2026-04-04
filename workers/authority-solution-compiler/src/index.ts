/**
 * authority-solution-compiler — SOLE cure compiler.
 * No other worker creates cure objects. All cures trace to evidence.
 */

import { Hono } from 'hono';
import {
  assertTenantId, createCureId, validateCure, type CureAction,
  wrapTruth, generateRequestId, POLICY_DEFAULTS, CANONICAL_WORKERS,
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
    }>;
  }>();
  assertTenantId(body.tenant_id);

  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' };
  const cures: CureAction[] = [];
  const errors: string[] = [];

  for (const diag of body.diagnoses) {
    if (!diag.evidence_ids || diag.evidence_ids.length === 0) {
      errors.push(`Diagnosis ${diag.diagnosis_id} has no evidence — cannot compile cure`);
      continue;
    }

    const cure: CureAction = {
      cure_id: createCureId(body.tenant_id, diag.category),
      tenant_id: body.tenant_id,
      diagnosis_id: diag.diagnosis_id,
      category: diag.category,
      action_type: mapSeverityToAction(diag.severity),
      target: diag.category,
      instructions: generateInstructions(diag),
      evidence_ids: diag.evidence_ids,
      priority: mapSeverityToPriority(diag.severity),
      estimated_impact: estimateImpact(diag.severity, diag.evidence_ids.length),
      confidence: computeCureConfidence(diag.evidence_ids.length),
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
    await c.env.ENGINE.fetch(new Request('http://internal/v1/tenants/' + body.tenant_id + '/cures/batch', {
      method: 'POST', headers, body: JSON.stringify({ cures }),
    }));
  }

  return c.json(wrapTruth(
    { compiled: cures.length, errors: errors.length, cure_ids: cures.map(c => c.cure_id), error_details: errors },
    c.env.WORKER_ID, generateRequestId()
  ));
});

function mapSeverityToAction(severity: string): CureAction['action_type'] {
  switch (severity) {
    case 'critical': return 'create';
    case 'high': return 'restructure';
    case 'medium': return 'optimize';
    case 'low': return 'update';
    default: return 'optimize';
  }
}

function mapSeverityToPriority(severity: string): number {
  switch (severity) {
    case 'critical': return 100;
    case 'high': return 75;
    case 'medium': return 50;
    case 'low': return 25;
    default: return 10;
  }
}

function estimateImpact(severity: string, evidenceCount: number): number {
  const base = severity === 'critical' ? 0.8 : severity === 'high' ? 0.6 : severity === 'medium' ? 0.4 : 0.2;
  const evidenceBoost = Math.min(0.2, evidenceCount * 0.02);
  return Math.min(1.0, base + evidenceBoost);
}

function computeCureConfidence(evidenceCount: number): number {
  return Math.min(0.95, 0.5 + evidenceCount * 0.05);
}

function generateInstructions(diag: { category: string; severity: string; description: string }): string {
  return `[${diag.severity.toUpperCase()}] ${diag.category}: ${diag.description}. Evidence-backed cure compiled from ${diag.category} analysis.`;
}

export default app;
