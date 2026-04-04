/**
 * Canonical artifact types and schemas.
 * Every artifact in the system conforms to one of these types.
 */

export type ArtifactKind =
  | 'faq' | 'schema_markup' | 'eeat_signal' | 'tofu_content'
  | 'mofu_content' | 'bofu_content' | 'citation_surface'
  | 'llms_txt' | 'knowledge_base' | 'cure_action';

export interface ContentArtifact {
  artifact_id: string;
  tenant_id: string;
  kind: ArtifactKind;
  content: string;
  content_hash: string;
  cure_refs: string[];
  created_at: string;
  version: number;
  metadata: Record<string, unknown>;
}

export function createArtifactId(kind: ArtifactKind, tenantId: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `art_${kind}_${tenantId.substring(0, 8)}_${ts}_${rand}`;
}
