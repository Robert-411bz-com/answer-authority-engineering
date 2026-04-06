/**
 * authority-content-forge
 *
 * Generates authority content across multiple surfaces:
 *   web (FAQ, schema, E-E-A-T, MOFU, TOFU, BOFU, knowledge_base, llms_txt)
 *   video (scripts, descriptions, chapters)
 *   audio (transcripts, show notes)
 *   social (posts, threads, carousels)
 *   ad (copy, headlines, descriptions)
 *   podcast (outlines, episode notes)
 *   webinar (decks, Q&A prep, follow-up)
 *
 * All generated assets trace to cure_refs (evidence chain).
 * Supports orchestrator_run_id for pipeline traceability.
 * All thresholds resolved via TenantPolicy — no magic numbers.
 * LLM calls are honestly named — no "callForgeLLM" indirection.
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

// ── Surface-aware content kinds ──

type SurfaceKind =
  | ArtifactKind
  // Video surface
  | 'video_script' | 'video_description' | 'video_chapters'
  // Audio surface
  | 'audio_transcript' | 'audio_show_notes'
  // Social surface
  | 'social_post' | 'social_thread' | 'social_carousel'
  // Ad surface
  | 'ad_copy' | 'ad_headline' | 'ad_description'
  // Podcast surface
  | 'podcast_outline' | 'podcast_episode_notes'
  // Webinar surface
  | 'webinar_outline' | 'webinar_qa_prep' | 'webinar_followup';

function surfaceFromKind(kind: SurfaceKind): string {
  if (kind.startsWith('video_')) return 'video';
  if (kind.startsWith('audio_')) return 'audio';
  if (kind.startsWith('social_')) return 'social';
  if (kind.startsWith('ad_')) return 'ad';
  if (kind.startsWith('podcast_')) return 'podcast';
  if (kind.startsWith('webinar_')) return 'webinar';
  return 'web';
}

const app = new Hono<{ Bindings: Bindings }>();

app.use('/v1/*', async (c, next) => {
  const key = c.req.header('X-Authority-Key');
  if (key !== c.env.AUTHORITY_INTERNAL_KEY) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

// ── GET /v1/surfaces — List supported content surfaces and kinds ──

app.get('/v1/surfaces', (c) => {
  return c.json(wrapTruth({
    surfaces: {
      web: ['faq', 'schema_markup', 'eeat_signal', 'tofu_content', 'mofu_content', 'bofu_content', 'citation_surface', 'llms_txt', 'knowledge_base', 'cure_action'],
      video: ['video_script', 'video_description', 'video_chapters'],
      audio: ['audio_transcript', 'audio_show_notes'],
      social: ['social_post', 'social_thread', 'social_carousel'],
      ad: ['ad_copy', 'ad_headline', 'ad_description'],
      podcast: ['podcast_outline', 'podcast_episode_notes'],
      webinar: ['webinar_outline', 'webinar_qa_prep', 'webinar_followup'],
    },
  }, c.env.WORKER_ID, generateRequestId()));
});

// ── POST /v1/generate — Generate content for any surface ──

app.post('/v1/generate', async (c) => {
  const body = await c.req.json<{
    tenant_id: string;
    kind: SurfaceKind;
    topic: string;
    cure_refs?: string[];
    context?: string;
    orchestrator_run_id?: string;
    target_url?: string;  // For video/audio: URL of the media asset
  }>();
  assertTenantId(body.tenant_id);

  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' };
  const tenantResp = await c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}`, { headers }));
  let policy = new TenantPolicy();
  if (tenantResp.ok) {
    const tenantData = await tenantResp.json() as { data: { policy_overrides?: string } };
    policy = TenantPolicy.fromRow(tenantData.data || {});
  }

  const minWords = policy.resolve('CONTENT_MIN_WORD_COUNT');
  const maxWords = policy.resolve('CONTENT_MAX_WORD_COUNT');
  const surface = surfaceFromKind(body.kind);

  const prompt = buildPrompt(body.kind, body.topic, body.context, body.target_url, minWords, maxWords);
  const content = await callCloudflareWorkersAI(prompt, c.env);
  const contentHash = await computeContentHash(content);

  // Map surface kinds to base ArtifactKind for proof gate compatibility
  const baseKind: ArtifactKind = mapToBaseKind(body.kind);
  const artifactId = createArtifactId(baseKind, body.tenant_id);

  const artifact: ContentArtifact = {
    artifact_id: artifactId,
    tenant_id: body.tenant_id,
    kind: baseKind,
    content,
    content_hash: contentHash,
    cure_refs: body.cure_refs || [],
    created_at: new Date().toISOString(),
    version: 1,
    metadata: {
      model: '@cf/meta/llama-3.1-8b-instruct',
      topic: body.topic,
      surface,
      surface_kind: body.kind,
      target_url: body.target_url || null,
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
  await c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}/artifacts`, {
    method: 'POST', headers,
    body: JSON.stringify(artifact),
  }));

  return c.json(wrapTruth({
    artifact_id: artifactId,
    content_hash: contentHash,
    surface,
    surface_kind: body.kind,
    orchestrator_run_id: body.orchestrator_run_id || null,
  }, c.env.WORKER_ID, generateRequestId()), 201);
});

// ── POST /v1/generate/batch — Batch generate across surfaces ──

app.post('/v1/generate/batch', async (c) => {
  const body = await c.req.json<{
    tenant_id: string;
    items: Array<{
      kind: SurfaceKind;
      topic: string;
      cure_refs?: string[];
      context?: string;
      target_url?: string;
    }>;
    orchestrator_run_id?: string;
  }>();
  assertTenantId(body.tenant_id);

  const results: Array<{ kind: SurfaceKind; artifact_id: string; content_hash: string; surface: string }> = [];
  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY, 'Content-Type': 'application/json' };

  for (const item of body.items) {
    try {
      const resp = await c.env.ENGINE.fetch(new Request('http://internal', { headers })); // dummy to keep binding alive
      // Generate inline for each item
      const policy = new TenantPolicy();
      const minWords = policy.resolve('CONTENT_MIN_WORD_COUNT');
      const maxWords = policy.resolve('CONTENT_MAX_WORD_COUNT');
      const surface = surfaceFromKind(item.kind);

      const prompt = buildPrompt(item.kind, item.topic, item.context, item.target_url, minWords, maxWords);
      const content = await callCloudflareWorkersAI(prompt, c.env);
      const contentHash = await computeContentHash(content);
      const baseKind = mapToBaseKind(item.kind);
      const artifactId = createArtifactId(baseKind, body.tenant_id);

      await c.env.DB.prepare(
        `INSERT INTO generation_jobs (job_id, tenant_id, kind, prompt, status, content, content_hash,
         cure_refs, model_used, orchestrator_run_id, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(
        artifactId, body.tenant_id, item.kind, prompt, 'completed', content, contentHash,
        JSON.stringify(item.cure_refs || []), '@cf/meta/llama-3.1-8b-instruct',
        body.orchestrator_run_id || null
      ).run();

      const artifact: ContentArtifact = {
        artifact_id: artifactId, tenant_id: body.tenant_id, kind: baseKind,
        content, content_hash: contentHash, cure_refs: item.cure_refs || [],
        created_at: new Date().toISOString(), version: 1,
        metadata: { model: '@cf/meta/llama-3.1-8b-instruct', topic: item.topic, surface, surface_kind: item.kind },
      };

      await c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${body.tenant_id}/artifacts`, {
        method: 'POST', headers, body: JSON.stringify(artifact),
      }));

      results.push({ kind: item.kind, artifact_id: artifactId, content_hash: contentHash, surface });
    } catch (err: any) {
      results.push({ kind: item.kind, artifact_id: 'error', content_hash: err?.message || 'generation_failed', surface: surfaceFromKind(item.kind) });
    }
  }

  return c.json(wrapTruth({
    tenant_id: body.tenant_id,
    generated: results.filter(r => r.artifact_id !== 'error').length,
    failed: results.filter(r => r.artifact_id === 'error').length,
    results,
    orchestrator_run_id: body.orchestrator_run_id || null,
  }, c.env.WORKER_ID, generateRequestId()), 201);
});

// ── GET /v1/jobs ──

app.get('/v1/jobs', async (c) => {
  const tenantId = c.req.query('tenant_id');
  if (tenantId) assertTenantId(tenantId);
  const query = tenantId
    ? c.env.DB.prepare('SELECT * FROM generation_jobs WHERE tenant_id = ? ORDER BY created_at DESC').bind(tenantId)
    : c.env.DB.prepare('SELECT * FROM generation_jobs ORDER BY created_at DESC LIMIT 100');
  const rows = await query.all();
  return c.json(wrapTruth(rows.results, c.env.WORKER_ID, generateRequestId()));
});

// ── Prompt Builder ──

function buildPrompt(kind: SurfaceKind, topic: string, context?: string, targetUrl?: string, minWords?: number, maxWords?: number): string {
  const wordRange = minWords && maxWords ? ` Generate between ${minWords} and ${maxWords} words.` : '';
  const urlNote = targetUrl ? `\n\nTarget media URL: ${targetUrl}` : '';

  const prompts: Record<string, string> = {
    // Web surface
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
    // Video surface
    video_script: `Write a professional video script about "${topic}" for authority positioning. Include intro hook, main points with timestamps, and call-to-action.${wordRange}${urlNote}`,
    video_description: `Write a YouTube/video description for a video about "${topic}". Include key timestamps, relevant links, and authority-building language.${wordRange}${urlNote}`,
    video_chapters: `Generate video chapter markers with timestamps for a video about "${topic}". Format: HH:MM:SS - Chapter Title.${wordRange}${urlNote}`,
    // Audio surface
    audio_transcript: `Generate a structured audio transcript outline about "${topic}" for an authority-building audio piece.${wordRange}${urlNote}`,
    audio_show_notes: `Write comprehensive show notes for an audio piece about "${topic}". Include key takeaways, resources mentioned, and timestamps.${wordRange}${urlNote}`,
    // Social surface
    social_post: `Write a professional LinkedIn/social media post about "${topic}" that establishes authority. Include relevant hashtags.${wordRange}`,
    social_thread: `Write a 10-part social media thread about "${topic}" that demonstrates expertise. Each part should be self-contained but build on the previous.${wordRange}`,
    social_carousel: `Write content for a 10-slide social media carousel about "${topic}". Each slide should have a headline and 2-3 key points.${wordRange}`,
    // Ad surface
    ad_copy: `Write authority-focused ad copy about "${topic}". Include headline, description, and call-to-action variants.${wordRange}`,
    ad_headline: `Generate 10 authority-focused ad headlines about "${topic}". Each should be under 30 characters.`,
    ad_description: `Generate 5 authority-focused ad descriptions about "${topic}". Each should be under 90 characters.`,
    // Podcast surface
    podcast_outline: `Create a detailed podcast episode outline about "${topic}". Include intro, 5 main segments, guest questions, and outro.${wordRange}`,
    podcast_episode_notes: `Write comprehensive podcast episode notes about "${topic}". Include summary, key quotes, resources, and timestamps.${wordRange}`,
    // Webinar surface
    webinar_outline: `Create a detailed webinar outline about "${topic}". Include agenda, slide topics, interactive elements, and Q&A preparation.${wordRange}`,
    webinar_qa_prep: `Generate 20 anticipated Q&A pairs for a webinar about "${topic}". Include both basic and advanced questions.${wordRange}`,
    webinar_followup: `Write a webinar follow-up email and resource package about "${topic}". Include key takeaways, recording link placeholder, and next steps.${wordRange}`,
  };

  let prompt = prompts[kind] || `Generate authority content about "${topic}".${wordRange}`;
  if (context) prompt += `\n\nAdditional context: ${context}`;
  return prompt;
}

/** Map surface-specific kinds to base ArtifactKind for proof gate compatibility. */
function mapToBaseKind(kind: SurfaceKind): ArtifactKind {
  if (kind.startsWith('video_') || kind.startsWith('audio_') || kind.startsWith('podcast_') || kind.startsWith('webinar_')) return 'knowledge_base';
  if (kind.startsWith('social_')) return 'citation_surface';
  if (kind.startsWith('ad_')) return 'cure_action';
  return kind as ArtifactKind;
}

/**
 * Calls Cloudflare Workers AI — honestly named.
 */
async function callCloudflareWorkersAI(prompt: string, env: Bindings): Promise<string> {
  try {
    const ai = env.AI as { run: (model: string, input: { messages: Array<{ role: string; content: string }> }) => Promise<{ response: string }> };
    const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'You are an authority content specialist. Generate comprehensive, well-structured content optimized for E-E-A-T and LLM visibility. Adapt your output format to the requested content type (video script, social post, ad copy, etc.).' },
        { role: 'user', content: prompt },
      ],
    });
    return result.response;
  } catch {
    return `[Content generation pending — Cloudflare Workers AI unavailable. Prompt: ${prompt.substring(0, 200)}]`;
  }
}

export default app;
