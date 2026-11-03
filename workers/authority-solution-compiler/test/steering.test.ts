/**
 * ASC cure_family steering. ASC stays the sole cure compiler; Fabric's cure_family picks
 * the action type only when the caller sets steer_cure_family: true.
 * All data is synthetic (fixture_ names).
 */

import { describe, expect, it } from 'vitest';
import app from '../src/index.js';

const KEY = 'fixture_internal_key';

async function compile(body: Record<string, unknown>) {
  const persisted: Array<{ diagnosis_id: string; action_type: string }> = [];
  const ENGINE = {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/cures/batch')) {
        persisted.push(...((await req.json()) as { cures: typeof persisted }).cures);
        return new Response('{}', { status: 201 });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    },
  } as unknown as Fetcher;
  const res = await app.request('/v1/compile', {
    method: 'POST',
    headers: { 'X-Authority-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: 'tenant_fixture_01', ...body }),
  }, { ENGINE, WORKER_ID: 'authority-solution-compiler', AUTHORITY_INTERNAL_KEY: KEY });
  const data = ((await res.json()) as { data: { compiled: number; errors: number; steered: number; skipped_none: number } }).data;
  const action = (id: string) => persisted.find(c => c.diagnosis_id === id)?.action_type;
  return { data, action };
}

// severity 'high' maps to 'restructure' without steering.
const diag = (id: string, cure_family?: string) => ({
  diagnosis_id: id, category: 'schema_coverage', severity: 'high', description: 'fixture_', evidence_ids: ['ev_fixture_1'],
  ...(cure_family ? { cure_family } : {}),
});

describe('ASC cure_family steering', () => {
  it('steer_cure_family true: the Fabric winner becomes the action type', async () => {
    const { data, action } = await compile({ steer_cure_family: true, diagnoses: [diag('d1', 'remove')] });
    expect(action('d1')).toBe('remove');
    expect(data.steered).toBe(1);
  });

  it('without steer_cure_family, cure_family is ignored and severity decides (shadow)', async () => {
    const { data, action } = await compile({ diagnoses: [diag('d1', 'remove')] });
    expect(action('d1')).toBe('restructure');
    expect(data.steered).toBe(0);
    const shadow = await compile({ steer_cure_family: false, diagnoses: [diag('d1', 'remove')] });
    expect(shadow.action('d1')).toBe('restructure');
  });

  it('none compiles no cure and is not an error', async () => {
    const { data, action } = await compile({ steer_cure_family: true, diagnoses: [diag('d1', 'none'), diag('d2', 'create')] });
    expect(action('d1')).toBeUndefined();
    expect(action('d2')).toBe('create');
    expect(data).toMatchObject({ compiled: 1, errors: 0, skipped_none: 1 });
  });

  it('an unknown family falls back to the severity mapping', async () => {
    const { action } = await compile({ steer_cure_family: true, diagnoses: [diag('d1', 'rewrite_everything')] });
    expect(action('d1')).toBe('restructure');
  });

  it('steering never bypasses the evidence rule', async () => {
    const { data } = await compile({
      steer_cure_family: true,
      diagnoses: [{ ...diag('d1', 'create'), evidence_ids: [] }],
    });
    expect(data.compiled).toBe(0);
    expect(data.errors).toBe(1);
  });
});
