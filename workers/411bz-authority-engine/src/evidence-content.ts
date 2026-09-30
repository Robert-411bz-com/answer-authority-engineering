/**
 * Evidence bytes. Evidence rows have always carried a content_hash; the bytes it hashed
 * were discarded. They are now kept in evidence_content, tenant-scoped, and served only
 * when they re-hash to the evidence row's content_hash. Unverifiable text is never served.
 */

import { computeContentHash, POLICY_DEFAULTS } from 'shared-authority-core';

/** Store the hashed bytes. Returns false (and stores nothing) when the text exceeds the cap. */
export async function storeEvidenceContent(
  db: D1Database, evidenceId: string, tenantId: string, content: string, contentHash: string,
  maxBytes: number = POLICY_DEFAULTS.EVIDENCE_CONTENT_MAX_BYTES,
): Promise<boolean> {
  if (new TextEncoder().encode(content).byteLength > maxBytes) return false;
  await db.prepare(
    'INSERT OR IGNORE INTO evidence_content (evidence_id, tenant_id, content, content_hash) VALUES (?, ?, ?, ?)'
  ).bind(evidenceId, tenantId, content, contentHash).run();
  return true;
}

export interface EvidenceWithContent extends Record<string, unknown> {
  evidence_id: string;
  content_hash: string;
  content?: string;
  content_verified: boolean;
}

/**
 * Evidence rows for a tenant, text-bearing rows first. `content` is present only when
 * the stored bytes hash to the evidence row's content_hash.
 */
export async function listEvidenceWithContent(
  db: D1Database, tenantId: string, limit: number, offset: number,
): Promise<EvidenceWithContent[]> {
  const rows = await db.prepare(
    `SELECT e.*, ec.content AS stored_content
     FROM evidence e
     LEFT JOIN evidence_content ec ON ec.evidence_id = e.evidence_id AND ec.tenant_id = e.tenant_id
     WHERE e.tenant_id = ?
     ORDER BY (ec.content IS NULL), e.extracted_at DESC
     LIMIT ? OFFSET ?`
  ).bind(tenantId, limit, offset).all<Record<string, unknown>>();

  const out: EvidenceWithContent[] = [];
  for (const r of rows.results || []) {
    const { stored_content, ...row } = r;
    const hash = String(row.content_hash);
    const verified = typeof stored_content === 'string' && stored_content.length > 0 &&
      (await computeContentHash(stored_content)) === hash;
    out.push({
      ...row,
      evidence_id: String(row.evidence_id),
      content_hash: hash,
      content_verified: verified,
      ...(verified ? { content: stored_content as string } : {}),
    });
  }
  return out;
}
