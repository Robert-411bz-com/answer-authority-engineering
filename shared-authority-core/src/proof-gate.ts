/**
 * Proof gate — structural validation before any artifact is persisted.
 * If it fails, the artifact does not enter the database.
 */

import { validateContentHash } from './content-hash.js';
import type { ContentArtifact } from './artifact-schema.js';

export interface ProofResult {
  passed: boolean;
  violations: string[];
}

export function enforceProofGate(artifact: Partial<ContentArtifact>): ProofResult {
  const violations: string[] = [];

  if (!artifact.tenant_id || artifact.tenant_id.trim() === '') {
    violations.push('Missing tenant_id');
  }
  if (!artifact.kind) {
    violations.push('Missing artifact kind');
  }
  if (!artifact.content || artifact.content.trim().length === 0) {
    violations.push('Empty content');
  }
  if (!artifact.content_hash || !validateContentHash(artifact.content_hash)) {
    violations.push('Invalid or missing content_hash (must be 64-char hex SHA-256)');
  }
  if (!artifact.artifact_id || !artifact.artifact_id.startsWith('art_')) {
    violations.push('Invalid artifact_id format');
  }

  return { passed: violations.length === 0, violations };
}
