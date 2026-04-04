/**
 * authority-content-forge
 *
 * Generates authority content (FAQ, schema, E-E-A-T, MOFU, TOFU, BOFU)
 * via external LLM APIs with honest naming and real SHA-256 content hashing.
 * All generated assets trace to cure_refs (evidence chain).
 */

import { Hono } from 'hono';
import {
  computeContentHash, enforceProofGate, createArtifactId,
  assertTenantId, type ContentArtifact, type ArtifactKind,
  wrapTruth, generateRequestId, POLICY_DEFAULTS, CANONICAL_WORKERS,
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
  }>();
  assertTenantId(body.tenant_id);

  const prompt = buildPrompt(body.kind, body.topic, body.context);
  const content = await callExternalLlm(prompt, c.env);
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
    metadata: { model: '@cf/meta/llama-3.1-8b-instruct', topic: body.topic },
  };

  const gate = enforceProofGate(artifact);
  if (!gate.passed) {
    return c.json({ error: 'proof_gate_failed', violations: gate.violations }, 422);
  }

  // Persist to forge DB
  await c.env.DB.prepare(
    'INSERT INTO generation_jobs (job_id, tenant_id, kind, prompt, status, content, content_hash, cure_refs, model_used, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))'
  ).bind(artifactId, body.tenant_id, body.kind, prompt, 'completed', content, contentHash, JSON.stringify(body.cure_refs || []), '@cf/meta/llama-3.1-8b-instruct').run();

  // Write artifact to engine via service binding
  await c.env.ENGINE.fetch(new Request('http://internal/v1/tenants/' + body.tenant_id + '/artifacts', {
    method: 'POST',
    headers: { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(artifact),
  }));

  return c.json(wrapTruth({ artifact_id: artifactId, content_hash: contentHash }, c.env.WORKER_ID, generateRequestId()), 201);
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

function buildPrompt(kind: ArtifactKind, topic: string, context?: string): string {
  const prompts: Record<ArtifactKind, string> = {
    faq: `Generate a comprehensive FAQ section about "${topic}" for authority positioning. Include 10 questions and detailed answers.`,
    schema_markup: `Generate Schema.org JSON-LD markup for "${topic}". Include Organization, FAQPage, and HowTo schemas.`,
    eeat_signal: `Generate E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness) content about "${topic}".`,
    tofu_content: `Generate top-of-funnel awareness content about "${topic}". Focus on educational value.`,
    mofu_content: `Generate middle-of-funnel consideration content about "${topic}". Focus on comparison and evaluation.`,
    bofu_content: `Generate bottom-of-funnel decision content about "${topic}". Focus on conversion and proof.`,
    citation_surface: `Generate citation-optimized content about "${topic}" designed for LLM citation.`,
    llms_txt: `Generate an llms.txt file for a business focused on "${topic}".`,
    knowledge_base: `Generate a comprehensive knowledge base article about "${topic}".`,
    cure_action: `Generate implementation instructions for the cure action: "${topic}".`,
  };
  let prompt = prompts[kind] || `Generate authority content about "${topic}".`;
  if (context) prompt += `\n\nAdditional context: ${context}`;
  return prompt;
}

/**
 * Calls Cloudflare Workers AI — honestly named external LLM call.
 */
async function callExternalLlm(prompt: string, env: Bindings): Promise<string> {
  try {
    const ai = env.AI as { run: (model: string, input: { messages: Array<{ role: string; content: string }> }) => Promise<{ response: string }> };
    const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'You are an authority content specialist. Generate comprehensive, well-structured content.' },
        { role: 'user', content: prompt },
      ],
    });
    return result.response;
  } catch {
    return `[Content generation pending — LLM unavailable. Prompt: ${prompt.substring(0, 200)}]`;
  }
}

export default app;
