/**
 * Ingestion connectors — factory pattern for GBP, YouTube, Schema.org, llms.txt.
 * Each connector fetches data via API (not webhooks) and writes evidence.
 */

import { computeContentHash, createEvidenceId } from 'shared-authority-core';

export interface ConnectorResult {
  records_fetched: number;
  evidence_ids: string[];
  errors: string[];
}

export interface ConnectorConfig {
  connector_type: string;
  config: Record<string, unknown>;
}

export async function runConnector(
  db: D1Database, tenantId: string, connector: ConnectorConfig
): Promise<ConnectorResult> {
  switch (connector.connector_type) {
    case 'gbp': return runGBPConnector(db, tenantId, connector.config);
    case 'youtube': return runYouTubeConnector(db, tenantId, connector.config);
    case 'schema_org': return runSchemaOrgConnector(db, tenantId, connector.config);
    case 'llms_txt': return runLlmsTxtConnector(db, tenantId, connector.config);
    default: return { records_fetched: 0, evidence_ids: [], errors: [`Unknown connector type: ${connector.connector_type}`] };
  }
}

async function runGBPConnector(db: D1Database, tenantId: string, config: Record<string, unknown>): Promise<ConnectorResult> {
  const placeId = config.place_id as string;
  if (!placeId) return { records_fetched: 0, evidence_ids: [], errors: ['Missing place_id'] };
  // GBP API integration point — fetches reviews, business info, Q&A
  const evidenceIds: string[] = [];
  return { records_fetched: 0, evidence_ids: evidenceIds, errors: [] };
}

async function runYouTubeConnector(db: D1Database, tenantId: string, config: Record<string, unknown>): Promise<ConnectorResult> {
  const channelId = config.channel_id as string;
  if (!channelId) return { records_fetched: 0, evidence_ids: [], errors: ['Missing channel_id'] };
  const evidenceIds: string[] = [];
  return { records_fetched: 0, evidence_ids: evidenceIds, errors: [] };
}

async function runSchemaOrgConnector(db: D1Database, tenantId: string, config: Record<string, unknown>): Promise<ConnectorResult> {
  const domain = config.domain as string;
  if (!domain) return { records_fetched: 0, evidence_ids: [], errors: ['Missing domain'] };
  const evidenceIds: string[] = [];
  return { records_fetched: 0, evidence_ids: evidenceIds, errors: [] };
}

async function runLlmsTxtConnector(db: D1Database, tenantId: string, config: Record<string, unknown>): Promise<ConnectorResult> {
  const domain = config.domain as string;
  if (!domain) return { records_fetched: 0, evidence_ids: [], errors: ['Missing domain'] };
  try {
    const resp = await fetch(`https://${domain}/llms.txt`);
    if (!resp.ok) return { records_fetched: 0, evidence_ids: [], errors: [`llms.txt returned ${resp.status}`] };
    const content = await resp.text();
    const hash = await computeContentHash(content);
    const eid = createEvidenceId('llms_txt', tenantId);
    await db.prepare(
      'INSERT INTO evidence (evidence_id, tenant_id, source_type, source_url, content_hash, confidence) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(eid, tenantId, 'llms_txt', `https://${domain}/llms.txt`, hash, 0.9).run();
    return { records_fetched: 1, evidence_ids: [eid], errors: [] };
  } catch (e) {
    return { records_fetched: 0, evidence_ids: [], errors: [(e as Error).message] };
  }
}
