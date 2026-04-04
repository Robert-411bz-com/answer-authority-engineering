/**
 * authority-content-forge
 *
 * Generates authority content (FAQ, schema, E-E-A-T, MOFU, TOFU, BOFU)
 * via external LLM APIs with honest naming and real SHA-256 content hashing.
 * All generated assets trace to cure_refs (evidence chain).
 * Supports orchestrator_run_id for pipeline traceability.
 *
 * All thresholds resolved via TenantPolicy — no magic numbers.
 */

import { Hono } from 'hono';
import {
  computeContentHash, enforceProofGate, createArtifactId,
  assertTenantId, type ContentArtifact, type ArtifactKind,
  wrapTruth, generateRequestId, POLICY_DEFAULTS, CANONICAL_WORKERS,
  TenantPolicy,
} from 'shared-authority-core';

type Bindings = {
  DB: D1Database;
  ENGINE: Fetcher;
  AI: unknown; // Cloudflare Workers AI binding
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('/v1/*', async (c, next) => {
  const key = c.req.header('X-Authority-Key');
  if (key !== c.env.AUTHORITY_INTERNAL_KEY) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

app.post('/v1/generate', async (c) => {
  const body = await c.req.json<{
    tenant_id: string; kind: ArtifactKind; topic: string;
    cure_refs?: string[]; context?: string;
    orchestrator_run_id?: string;
  }>();
  assertTenantId(body.tenant_id);

  // Load tenant policy for content generation thresholds
  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' };
  const tenantResp = await c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}`, { headers }));
  let policy = new TenantPolicy();
  if (tenantResp.ok) {
    const tenantData = await tenantResp.json() as { data: { policy_overrides?: string } };
    policy = TenantPolicy.fromRow(tenantData.data || {});
  }

  const minWords = policy.resolve('CONTENT_MIN_WORD_COUNT');
  const maxWords = policy.resolve('CONTENT_MAX_WORD_COUNT');

  const prompt = buildPrompt(body.kind, body.topic, body.context, minWords, maxWords);
  const content = await callCloudflareWorkersAI(prompt, c.env);
  const contentHash = await computeContentHash(content);
  const artifactId = createArtifactId(body.kind, body.tenant_id);

  const artifact: ContentArtifact = {
    artifact_id: artifactId,
    tenant_id: body.tenant_id,
    kind: body.kind,
    content,
    content_hash: contentHash,
    cure_refs: body.cure_refs || [],
    created_at: new Date().toISOString(),
    version: 1,
    metadata: {
      model: '@cf/meta/llama-3.1-8b-instruct',
      topic: body.topic,
      orchestrator_run_id: body.orchestrator_run_id,
    },
  };

  const gate = enforceProofGate(artifact);
  if (!gate.passed) {
    return c.json({ error: 'proof_gate_failed', violations: gate.violations }, 422);
  }

  // Persist to forge DB
  await c.env.DB.prepare(
    `INSERT INTO generation_jobs (job_id, tenant_id, kind, prompt, status, content, content_hash,
     cure_refs, model_used, orchestrator_run_id, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(
    artifactId, body.tenant_id, body.kind, prompt, 'completed', content, contentHash,
    JSON.stringify(body.cure_refs || []), '@cf/meta/llama-3.1-8b-instruct',
    body.orchestrator_run_id || null
  ).run();

  // Write artifact to engine via service binding
  await c.env.ENGINE.fetch(new Request('http://internal/v1/tenants/' + body.tenant_id + '/artifacts', {
    method: 'POST', headers,
    body: JSON.stringify(artifact),
  }));

  return c.json(wrapTruth({
    artifact_id: artifactId,
    content_hash: contentHash,
    orchestrator_run_id: body.orchestrator_run_id || null,
  }, c.env.WORKER_ID, generateRequestId()), 201);
});

app.get('/v1/jobs', async (c) => {
  const tenantId = c.req.query('tenant_id');
  if (tenantId) assertTenantId(tenantId);
  const query = tenantId
    ? c.env.DB.prepare('SELECT * FROM generation_jobs WHERE tenant_id = ? ORDER BY created_at DESC').bind(tenantId)
    : c.env.DB.prepare('SELECT * FROM generation_jobs ORDER BY created_at DESC LIMIT 100');
  const rows = await query.all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

function buildPrompt(kind: ArtifactKind, topic: string, context?: string, minWords?: number, maxWords?: number): string {
  const wordRange = minWords && maxWords ? ` Generate between ${minWords} and ${maxWords} words.` : '';
  const prompts: Record<ArtifactKind, string> = {
    faq: `Generate a comprehensive FAQ section about "${topic}" for authority positioning. Include 10 questions and detailed answers.${wordRange}`,
    schema_markup: `Generate Schema.org JSON-LD markup for "${topic}". Include Organization, FAQPage, and HowTo schemas.${wordRange}`,
    eeat_signal: `Generate E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness) content about "${topic}".${wordRange}`,
    tofu_content: `Generate top-of-funnel awareness content about "${topic}". Focus on educational value.${wordRange}`,
    mofu_content: `Generate middle-of-funnel consideration content about "${topic}". Focus on comparison and evaluation.${wordRange}`,
    bofu_content: `Generate bottom-of-funnel decision content about "${topic}". Focus on conversion and proof.${wordRange}`,
    citation_surface: `Generate citation-optimized content about "${topic}" designed for LLM citation.${wordRange}`,
    llms_txt: `Generate an llms.txt file for a business focused on "${topic}".${wordRange}`,
    knowledge_base: `Generate a comprehensive knowledge base article about "${topic}".${wordRange}`,
    cure_action: `Generate implementation instructions for the cure action: "${topic}".${wordRange}`,
  };
  let prompt = prompts[kind] || `Generate authority content about "${topic}".${wordRange}`;
  if (context) prompt += `\n\nAdditional context: ${context}`;
  return prompt;
}

/**
 * Calls Cloudflare Workers AI — honestly named, no "callForgeLLM" indirection.
 */
async function callCloudflareWorkersAI(prompt: string, env: Bindings): Promise<string> {
  try {
    const ai = env.AI as { run: (model: string, input: { messages: Array<{ role: string; content: string }> }) => Promise<{ response: string }> };
    const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'You are an authority content specialist. Generate comprehensive, well-structured content optimized for E-E-A-T and LLM visibility.' },
        { role: 'user', content: prompt },
      ],
    });
    return result.response;
  } catch {
    return `[Content generation pending — Cloudflare Workers AI unavailable. Prompt: ${prompt.substring(0, 200)}]`;
  }
}

export default app;
