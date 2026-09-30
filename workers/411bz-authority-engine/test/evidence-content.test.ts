/**
 * Evidence bytes: stored beside the hash, served only when they re-hash to it,
 * tenant-scoped. Drives the real engine routes over the real authority schema.
 * All data is synthetic (fixture_ names).
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from 'shared-authority-core';
import app from '../src/index.js';
import { storeEvidenceContent } from '../src/evidence-content.js';
import { makeD1 } from '../../../test-support/sqljs-d1.js';

const SCHEMA = fileURLToPath(new URL('../db/authority-schema.sql', import.meta.url));
const KEY = 'fixture_internal_key';
const headers = { 'X-Authority-Key': KEY, 'Content-Type': 'application/json' };

async function setup() {
  const db = await makeD1(SCHEMA);
  for (const [tid, domain] of [['tenant_fixture_01', 'fixture-a.test'], ['tenant_fixture_02', 'fixture-b.test']]) {
    db.raw.run('INSERT INTO tenants (tenant_id, domain, business_name) VALUES (?, ?, ?)', [tid, domain, `fixture_${domain}`]);
  }
  const env = { DB: db.d1, ARTIFACTS_BUCKET: {} as R2Bucket, WORKER_ID: '411bz-authority-engine', AUTHORITY_INTERNAL_KEY: KEY };
  const post = (tid: string, content: string) => app.request(`/v1/tenants/${tid}/evidence`, {
    method: 'POST', headers, body: JSON.stringify({ source_type: 'llms_txt', source_url: 'https://fixture-a.test/llms.txt', content, confidence: 0.9 }),
  }, env);
  const list = async (tid: string, include = true) => {
    const r = await app.request(`/v1/tenants/${tid}/evidence?limit=50${include ? '&include_content=1' : ''}`, { headers }, env);
    return ((await r.json()) as { data: { items: Array<Record<string, unknown>> } }).data.items;
  };
  return { db, env, post, list };
}

describe('evidence content', () => {
  it('POST keeps the bytes it hashed, and include_content serves them verified', async () => {
    const { post, list } = await setup();
    const res = await post('tenant_fixture_01', 'fixture_ Harbor Plumbing serves Portland.');
    expect(res.status).toBe(201);
    expect(((await res.json()) as { content_stored: boolean }).content_stored).toBe(true);
    const [item] = await list('tenant_fixture_01');
    expect(item!.content_verified).toBe(true);
    expect(item!.content).toBe('fixture_ Harbor Plumbing serves Portland.');
  });

  it('without include_content the response is unchanged: no content fields', async () => {
    const { post, list } = await setup();
    await post('tenant_fixture_01', 'fixture_ text');
    const [item] = await list('tenant_fixture_01', false);
    expect(item).not.toHaveProperty('content');
    expect(item).not.toHaveProperty('content_verified');
  });

  it('bytes that no longer match the hash are withheld, not served', async () => {
    const { db, post, list } = await setup();
    await post('tenant_fixture_01', 'fixture_ original text');
    db.raw.run("UPDATE evidence_content SET content = 'fixture_ tampered text'");
    const [item] = await list('tenant_fixture_01');
    expect(item!.content_verified).toBe(false);
    expect(item).not.toHaveProperty('content');
  });

  it('text is tenant-scoped: another tenant never receives it', async () => {
    const { db, post, list } = await setup();
    await post('tenant_fixture_01', 'fixture_ tenant one secret');
    // Even a mis-keyed content row for tenant 02 on tenant 01's evidence id is not joined.
    db.raw.run("UPDATE evidence_content SET tenant_id = 'tenant_fixture_02'");
    const [item] = await list('tenant_fixture_01');
    expect(item!.content_verified).toBe(false);
    expect(await list('tenant_fixture_02')).toEqual([]);
  });

  it('text over the byte cap is not stored', async () => {
    const { db } = await setup();
    const big = 'x'.repeat(100);
    const stored = await storeEvidenceContent(db.d1, 'ev_fixture_big', 'tenant_fixture_01', big, await computeContentHash(big), 50);
    expect(stored).toBe(false);
    expect(db.query('SELECT COUNT(*) AS n FROM evidence_content')[0]!.n).toBe(0);
  });

  it('D4: evidence ingestion still succeeds when the text store is unavailable (schema not yet applied)', async () => {
    const { db, post, list } = await setup();
    db.raw.run('DROP TABLE evidence_content');
    const res = await post('tenant_fixture_01', 'fixture_ text');
    expect(res.status).toBe(201);
    expect(((await res.json()) as { content_stored: boolean }).content_stored).toBe(false);
    expect(await list('tenant_fixture_01', false)).toHaveLength(1);
  });

  it('text-bearing rows come first', async () => {
    const { db, post, list } = await setup();
    await post('tenant_fixture_01', 'fixture_ with text');
    db.raw.run("INSERT INTO evidence (evidence_id, tenant_id, source_type, source_url, content_hash, extracted_at) VALUES ('ev_fixture_newer', 'tenant_fixture_01', 'crawl', 'https://fixture-a.test/', ?, datetime('now', '+1 day'))", ['b'.repeat(64)]);
    const items = await list('tenant_fixture_01');
    expect(items[0]!.content_verified).toBe(true);
    expect(items[1]!.evidence_id).toBe('ev_fixture_newer');
  });
});
