/**
 * Test harness: a D1 adapter over sql.js running the real orchestrator schema,
 * fake service bindings, and a scripted TypeSafe endpoint.
 * All data here is synthetic (fixture_ names); none of it is evidence of anything.
 */

import { fileURLToPath } from 'node:url';
import { makeD1 } from '../../../test-support/sqljs-d1.js';
import type { Bindings, PipelineDeps } from '../src/pipeline.js';
import { INERT_LOCAL_HEAD } from '../src/fabric/types.js';

const SCHEMA_PATH = fileURLToPath(new URL('../db/orchestrator-schema.sql', import.meta.url));
export const makeDb = () => makeD1(SCHEMA_PATH);

// ── Call log shared by services and Jev, for ordering assertions ──

export interface Call { seq: number; target: string; method: string; path: string; body: unknown }

export const HASH_A = 'a'.repeat(64);

export interface Scenario {
  compiled?: number;
  artifactContent?: string;
  dryRunVerdict?: string;
  /** false: the engine has no hash-verified text for any evidence row. */
  evidenceText?: boolean;
  /** Evidence row count the engine reports (drives the evidence_graph heuristic). */
  evidenceTotal?: number;
}

const DIAGNOSES = [
  { diagnosis_id: 'diag_fixture_1', category: 'schema_coverage', severity: 'high', description: 'fixture_ no schema.json', evidence_ids: ['ev_fixture_1'] },
  { diagnosis_id: 'diag_fixture_2', category: 'llm_visibility', severity: 'medium', description: 'fixture_ no llms.txt', evidence_ids: ['ev_fixture_2'] },
];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export function makeServices(log: Call[], seq: { n: number }, sc: Scenario = {}) {
  let aiiCalls = 0;
  // Faithful round trip: the artifact carries exactly the cure_refs forge was sent.
  let forgedCureRefs: unknown = [];
  const svc = (target: string, handler: (method: string, path: string, body: unknown, url: URL) => Response) => ({
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' ? null : await req.json().catch(() => null);
      log.push({ seq: ++seq.n, target, method: req.method, path: url.pathname, body });
      return handler(req.method, url.pathname, body, url);
    },
  }) as unknown as Fetcher;

  return {
    ENGINE: svc('ENGINE', (m, p, _b, url) => {
      if (m === 'GET' && p === '/v1/tenants/tenant_fixture_01') {
        return json({ data: { tenant_id: 'tenant_fixture_01', domain: 'fixture-harbor.test', business_name: 'fixture_Harbor Plumbing', business_type: 'plumber' } });
      }
      if (p.endsWith('/compute-aii')) return json({ data: { aii: aiiCalls++ === 0 ? 0.5 : 0.6 } });
      if (p === '/v1/connectors/ingest') return json({ data: { connector_results: [{ connector: 'fixture' }] } });
      if (p.endsWith('/evidence')) {
        const row = { evidence_id: 'ev_fixture_1', source_type: 'llms_txt', source_url: 'https://fixture-harbor.test/llms.txt', content_hash: HASH_A, metadata: '{}' };
        const unverified = { evidence_id: 'ev_fixture_2', source_type: 'crawl', source_url: 'https://fixture-harbor.test/', content_hash: HASH_A, metadata: '{}' };
        if (url.searchParams.get('include_content') !== '1') return json({ data: { items: [row, unverified], total: sc.evidenceTotal ?? 70 } });
        const text = sc.evidenceText === false
          ? { content_verified: false }
          : { content_verified: true, content: 'fixture_ Harbor Plumbing is a plumber serving Portland.' };
        return json({ data: { items: [{ ...row, ...text }, { ...unverified, content_verified: false }], total: sc.evidenceTotal ?? 70 } });
      }
      if (p.endsWith('/diagnoses/batch')) return json({ data: { ok: true } });
      if (p.endsWith('/diagnoses')) return json({ data: DIAGNOSES });
      if (p.endsWith('/artifacts')) {
        return json({ data: [{
          artifact_id: 'art_fixture_1', kind: 'faq', content_hash: HASH_A,
          content: sc.artifactContent ?? 'fixture_ Harbor Plumbing serves Portland.',
          cure_refs: JSON.stringify(forgedCureRefs),
        }] });
      }
      if (p === '/v1/scorecard/publish') return json({ data: { ok: true } });
      return json({ error: 'unhandled' }, 404);
    }),
    EXAMINER: svc('EXAMINER', () => json({ data: { overall_score: 0.8, diagnoses: DIAGNOSES } })),
    SCHEMA_ENGINE: svc('SCHEMA_ENGINE', () => json({ data: { schema_health_score: 1, surfaces_present: 5, surfaces_total: 5, findings: [] } })),
    COMPILER: svc('COMPILER', () => {
      const n = sc.compiled ?? 2;
      const cure_ids = Array.from({ length: n }, (_, i) => `cure_fixture_${i + 1}`);
      return json({ data: { compiled: n, errors: 0, cure_ids } });
    }),
    FORGE: svc('FORGE', (_m, _p, body) => {
      forgedCureRefs = (body as { cure_refs?: unknown }).cure_refs ?? [];
      return json({ data: { artifact_id: 'art_fixture_1', content_hash: HASH_A, surface_kind: 'faq' } }, 201);
    }),
    OBSERVATORY: svc('OBSERVATORY', (_m, p, body) => {
      if (p === '/v1/probe') return json({ data: { probes: [{ status: 200 }, { status: 200 }] } });
      const dry = (body as { dry_run?: boolean }).dry_run;
      return json({ data: { verdict: dry ? (sc.dryRunVerdict ?? 'dry_run_passed') : 'deployed' } });
    }),
  };
}

// ── Scripted TypeSafe ──

export type WireAnswer = { type: string; noul?: number; choice?: string; score?: number; probabilities?: Record<string, number> };
export const noul = (p: number): WireAnswer => ({ type: 'noul', noul: p });
export const choice = (probs: Record<string, number>): WireAnswer => {
  const winner = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: 'choice', choice: winner, probabilities: probs };
};
export const score = (probs: Record<string, number>): WireAnswer => ({ type: 'score', score: 0, probabilities: probs });

export const TYPESAFE_HOST = 'api.typesafe.ai';
export const PINNED_MODEL = 'jev-1.13.0';

/** Answers that make every gate agree to ship. Override per question id. */
export const AGREE: Record<string, WireAnswer> = {
  entity_defined: noul(0.95),
  cure_family: choice({ create: 0.9, update: 0.04, optimize: 0.02, remove: 0.01, restructure: 0.01, none: 0.02 }),
  gap_severity: score({ '0': 0.05, '1': 0.1, '2': 0.2, '3': 0.5, '4': 0.15 }),
  claim_supported: noul(0.95),
  deploy_route: choice({ auto_execute: 0.95, pause_for_review: 0.04, reject: 0.01 }),
  citation_ready: noul(0.7),
  citation_outcome: choice({ cited_us: 0.6, cited_competitor: 0.2, omitted: 0.15, hallucinated_us: 0.05 }),
  utterance_intent: choice({ sales: 0.02, support: 0.03, scheduling: 0.02, information: 0.9, other: 0.03 }),
  utterance_urgent: noul(0.05),
  utterance_pii: noul(0.02),
};

export interface JevOptions {
  answers?: Record<string, WireAnswer>;
  status?: number;
}

export function makeJev(log: Call[], seq: { n: number }, opts: JevOptions = {}): typeof fetch {
  const answers = { ...AGREE, ...(opts.answers || {}) };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = JSON.parse(String(init?.body ?? '{}')) as { questions: Record<string, unknown>; model: string };
    log.push({ seq: ++seq.n, target: 'TYPESAFE', method: 'POST', path: `${url.host}${url.pathname}`, body });
    if (opts.status && opts.status !== 200) return new Response('{"error":"boom"}', { status: opts.status });
    const out: Record<string, WireAnswer> = {};
    for (const key of Object.keys(body.questions)) {
      const a = answers[key.split('__')[0]!];
      if (a) out[key] = a;
    }
    return json({ model: PINNED_MODEL, answers: out, usage: { input_tokens: 100, output_tokens: 0 } });
  }) as typeof fetch;
}

// ── Env builder ──

export async function makeEnv(opts: { mode: string; jev?: JevOptions; scenario?: Scenario }) {
  const log: Call[] = [];
  const seq = { n: 0 };
  const db = await makeDb();
  const env: Bindings = {
    DB: db.d1,
    ...makeServices(log, seq, opts.scenario),
    WORKER_ID: '411bz-orchestrator',
    AUTHORITY_INTERNAL_KEY: 'fixture_internal_key',
    FABRIC_MODE: opts.mode,
    TYPESAFE_API_KEY: 'fixture_typesafe_test_key',
    TYPESAFE_MODEL: PINNED_MODEL,
  };
  const deps: PipelineDeps = { fetch: makeJev(log, seq, opts.jev), localHead: INERT_LOCAL_HEAD };
  const runId = `run_fixture_${Math.random().toString(36).slice(2, 8)}`;
  db.raw.run('INSERT INTO pipeline_runs (run_id, tenant_id, current_stage, status) VALUES (?, ?, ?, ?)', [runId, 'tenant_fixture_01', 'ingest', 'running']);
  return { env, deps, log, db, runId };
}
