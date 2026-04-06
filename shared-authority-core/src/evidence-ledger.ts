/**
 * Evidence ledger — immutable record of all evidence supporting authority claims.
 * Every cure, score, and diagnosis traces back to evidence entries.
 */

export interface EvidenceEntry {
  evidence_id: string;
  tenant_id: string;
  source_type: 'gbp' | 'youtube' | 'schema_org' | 'llms_txt' | 'manual' | 'probe' | 'crawl';
  source_url: string;
  extracted_at: string;
  content_hash: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

export function createEvidenceId(sourceType: string, tenantId: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `ev_${sourceType}_${tenantId.substring(0, 8)}_${ts}_${rand}`;
}

export function validateEvidence(entry: Partial<EvidenceEntry>): string[] {
  const errors: string[] = [];
  if (!entry.tenant_id) errors.push('Missing tenant_id');
  if (!entry.source_type) errors.push('Missing source_type');
  if (!entry.source_url) errors.push('Missing source_url');
  if (!entry.content_hash) errors.push('Missing content_hash');
  if (entry.confidence === undefined || entry.confidence < 0 || entry.confidence > 1) {
    errors.push('Confidence must be between 0 and 1');
  }
  return errors;
}
