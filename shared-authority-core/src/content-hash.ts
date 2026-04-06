/**
 * SHA-256 content hashing for all artifacts.
 * Every artifact MUST have a real hash — no placeholders, no empty strings.
 */

export async function computeContentHash(content: string): Promise<string> {
  if (!content || content.trim().length === 0) {
    throw new Error('Cannot hash empty content. Artifact content must be non-empty.');
  }
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function validateContentHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}

export function assertContentHash(hash: string): void {
  if (!validateContentHash(hash)) {
    throw new Error(`Invalid content hash: "${hash}". Must be 64-char hex SHA-256.`);
  }
}
