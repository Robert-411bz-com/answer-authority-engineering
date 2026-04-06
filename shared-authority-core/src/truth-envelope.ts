/**
 * Truth envelope — wraps every inter-worker response with provenance metadata.
 */

export interface TruthEnvelope<T> {
  data: T;
  source_worker: string;
  timestamp: string;
  request_id: string;
  content_hash?: string;
}

export function wrapTruth<T>(data: T, sourceWorker: string, requestId: string, contentHash?: string): TruthEnvelope<T> {
  return {
    data,
    source_worker: sourceWorker,
    timestamp: new Date().toISOString(),
    request_id: requestId,
    content_hash: contentHash,
  };
}

export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}
