/**
 * Authority Solution Compiler contracts.
 * ASC is the SOLE cure compiler — no other worker creates cure objects.
 */

export interface CureAction {
  cure_id: string;
  tenant_id: string;
  diagnosis_id: string;
  category: string;
  action_type: 'create' | 'update' | 'optimize' | 'remove' | 'restructure';
  target: string;
  instructions: string;
  evidence_ids: string[];
  priority: number;
  estimated_impact: number;
  confidence: number;
  status: 'pending' | 'approved' | 'deployed' | 'verified' | 'rejected';
  created_at: string;
}

export function createCureId(tenantId: string, category: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `cure_${category.substring(0, 12)}_${tenantId.substring(0, 8)}_${ts}_${rand}`;
}

export function validateCure(cure: Partial<CureAction>): string[] {
  const errors: string[] = [];
  if (!cure.tenant_id) errors.push('Missing tenant_id');
  if (!cure.diagnosis_id) errors.push('Missing diagnosis_id');
  if (!cure.category) errors.push('Missing category');
  if (!cure.evidence_ids || cure.evidence_ids.length === 0) {
    errors.push('Cure must reference at least one evidence_id');
  }
  if (cure.confidence === undefined || cure.confidence < 0 || cure.confidence > 1) {
    errors.push('Confidence must be between 0 and 1');
  }
  if (cure.estimated_impact === undefined || cure.estimated_impact < 0 || cure.estimated_impact > 1) {
    errors.push('estimated_impact must be between 0 and 1');
  }
  return errors;
}
