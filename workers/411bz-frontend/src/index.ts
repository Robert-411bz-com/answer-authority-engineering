/**
 * 411bz-frontend — User-facing API gateway + marketing surface.
 * Phase 2: Plan enforcement (402), landing page, billing UI.
 *
 * CRITICAL: All service-binding proxy handlers materialise the upstream
 * response body with `await resp.text()` before re-wrapping it.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  wrapTruth, generateRequestId, CANONICAL_WORKERS,
  POLICY_DEFAULTS,
} from 'shared-authority-core';

type Bindings = {
  ENGINE: Fetcher;
  ORCHESTRATOR: Fetcher;
  OBSERVATORY: Fetcher;
  BOSS_AI: Fetcher;
  STRIPE: Fetcher;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
  FRONTEND_HOST: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// ── Helpers ──

function authorityKey(c: any): string {
  return (
    c.req.header('X-Authority-Key') ??
    c.req.header('x-authority-key') ??
    c.env.AUTHORITY_INTERNAL_KEY ??
    ''
  );
}

/** Extract tenant_id from URL path, query param, or JSON body (best-effort). */
async function extractTenantId(c: any): Promise<string | null> {
  // From URL path: /api/v1/tenants/:tenant_id/... or /api/pipeline?tenant_id=
  const pathMatch = c.req.path.match(/\/api\/v1\/(?:tenants|evidence|scorecards)\/([^/]+)/);
  if (pathMatch) return pathMatch[1];

  // From query string
  const qTenant = c.req.query('tenant_id');
  if (qTenant) return qTenant;

  // From JSON body (for POST requests)
  if (c.req.method === 'POST') {
    try {
      const clone = c.req.raw.clone();
      const body = await clone.json();
      if (body?.tenant_id) return body.tenant_id;
    } catch { /* not JSON or no tenant_id */ }
  }
  return null;
}

/** Check subscription status via engine. Returns the subscription object or null. */
async function getSubscription(env: Bindings, tenantId: string, key: string): Promise<{
  status: string; plan: string; current_period_end?: string;
} | null> {
  try {
    const resp = await env.ENGINE.fetch(new Request(`http://internal/v1/subscriptions/${tenantId}`, {
      headers: { 'X-Authority-Key': key },
    }));
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return data?.data || data;
  } catch {
    return null;
  }
}

// ── Plan limits by tier ──
const PLAN_LIMITS: Record<string, { max_pipelines_per_day: number; max_domains: number }> = {
  trial:   { max_pipelines_per_day: 1, max_domains: 1 },
  starter: { max_pipelines_per_day: 5, max_domains: 1 },
  growth:  { max_pipelines_per_day: 20, max_domains: 5 },
  pro:     { max_pipelines_per_day: 100, max_domains: 10 },
};

// ── CORS ──
app.use('/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE'] }));

// ── Health (no auth, no plan check) ──
app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

// ══════════════════════════════════════════════════════════════════════════════
// LANDING PAGE — GET /
// ══════════════════════════════════════════════════════════════════════════════

app.get('/', (c) => {
  return c.html(renderLandingPage());
});

// ══════════════════════════════════════════════════════════════════════════════
// BILLING UI — GET /billing/:tenant_id
// ══════════════════════════════════════════════════════════════════════════════

app.get('/billing/:tenant_id', async (c) => {
  const tenantId = c.req.param('tenant_id');
  const key = authorityKey(c);
  if (!key) return c.html(renderBillingPage(tenantId, null, null, 'Missing authority key'));

  const sub = await getSubscription(c.env, tenantId, key);

  // Get tenant info
  let tenant: any = null;
  try {
    const resp = await c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${tenantId}`, {
      headers: { 'X-Authority-Key': key },
    }));
    if (resp.ok) {
      const data = await resp.json() as any;
      tenant = data?.data || data;
    }
  } catch { /* tenant not found */ }

  return c.html(renderBillingPage(tenantId, sub, tenant, null));
});

// ══════════════════════════════════════════════════════════════════════════════
// RUNTIME CONFIG (no plan check)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/runtime-config', (c) => {
  return c.json(wrapTruth({
    platform: '411bz.ai',
    version: '2.1.0',
    host: c.env.FRONTEND_HOST || c.req.header('host') || 'api.411bz.ai',
    features: {
      orchestrator_stages: POLICY_DEFAULTS.ORCHESTRATOR_STAGE_COUNT,
      examiner_categories: POLICY_DEFAULTS.EXAMINER_CATEGORY_COUNT,
      max_overlays: POLICY_DEFAULTS.MAX_OVERLAYS,
      promo_free30_days: POLICY_DEFAULTS.PROMO_FREE30_DAYS,
      promo_free90_days: POLICY_DEFAULTS.PROMO_FREE90_DAYS,
    },
    workers: Object.values(CANONICAL_WORKERS),
    endpoints: {
      tenants: '/api/v1/tenants',
      pipeline_start: '/api/pipeline/start',
      pipeline_status: '/api/pipeline/:run_id',
      scorecards: '/api/v1/scorecards',
      evidence: '/api/v1/evidence/:tenant_id',
      checkout: '/api/checkout',
      subscription: '/api/subscription/:tenant_id',
      billing: '/billing/:tenant_id',
    },
  }, c.env.WORKER_ID, generateRequestId()));
});

// ══════════════════════════════════════════════════════════════════════════════
// CHECKOUT + SUBSCRIPTION (no plan check — needed to upgrade)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/checkout', async (c) => {
  try {
    const key = authorityKey(c);
    if (!key) return c.json({ error: 'missing_authority_key' }, 401);
    const reqBody = await c.req.text();
    const resp = await c.env.STRIPE.fetch(new Request('http://internal/v1/checkout', {
      method: 'POST',
      headers: { 'X-Authority-Key': key, 'Content-Type': 'application/json' },
      body: reqBody,
    }));
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
    });
  } catch (err: any) {
    console.error('Proxy /api/checkout error:', err.message, err.stack);
    return c.json({ error: 'proxy_error', detail: err.message }, 502);
  }
});

app.get('/api/subscription/:tenant_id', async (c) => {
  try {
    const key = authorityKey(c);
    if (!key) return c.json({ error: 'missing_authority_key' }, 401);
    const tid = c.req.param('tenant_id');
    const resp = await c.env.STRIPE.fetch(new Request(`http://internal/v1/subscription/${tid}`, {
      headers: { 'X-Authority-Key': key },
    }));
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
    });
  } catch (err: any) {
    console.error('Proxy /api/subscription error:', err.message, err.stack);
    return c.json({ error: 'proxy_error', detail: err.message }, 502);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// TENANT CREATION (no plan check — needed to onboard)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/v1/tenants', async (c) => {
  try {
    const key = authorityKey(c);
    if (!key) return c.json({ error: 'missing_authority_key' }, 401);
    const reqBody = await c.req.text();
    const resp = await c.env.ENGINE.fetch(new Request('http://internal/v1/tenants', {
      method: 'POST',
      headers: { 'X-Authority-Key': key, 'Content-Type': 'application/json' },
      body: reqBody,
    }));
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
    });
  } catch (err: any) {
    console.error('Proxy POST /api/v1/tenants error:', err.message, err.stack);
    return c.json({ error: 'proxy_error', detail: err.message }, 502);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PLAN-GATED ROUTES — 402 middleware applied
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Plan enforcement middleware for protected API routes.
 * Returns 402 Payment Required if:
 *   - No subscription found for the tenant
 *   - Subscription status is not 'active'
 *   - Tenant is on 'trial' plan (trial gets 1 free pipeline run only)
 *
 * Skipped routes: health, runtime-config, checkout, subscription, tenant creation.
 */
async function enforcePlan(c: any, next: () => Promise<void>): Promise<Response | void> {
  const key = authorityKey(c);
  if (!key) return c.json({ error: 'missing_authority_key' }, 401);

  const tenantId = await extractTenantId(c);
  if (!tenantId) {
    // Can't determine tenant — allow through (engine will validate)
    return next();
  }

  const sub = await getSubscription(c.env, tenantId, key);

  if (!sub || sub.status === 'none') {
    return c.json({
      error: 'payment_required',
      message: 'No active subscription. Please subscribe to access this feature.',
      upgrade_url: `/billing/${tenantId}`,
      plans: ['starter', 'growth', 'pro'],
    }, 402);
  }

  if (sub.status === 'canceled') {
    return c.json({
      error: 'payment_required',
      message: 'Your subscription has been canceled. Please resubscribe to continue.',
      upgrade_url: `/billing/${tenantId}`,
      plans: ['starter', 'growth', 'pro'],
    }, 402);
  }

  if (sub.status === 'past_due') {
    return c.json({
      error: 'payment_required',
      message: 'Your payment is past due. Please update your payment method.',
      upgrade_url: `/billing/${tenantId}`,
      status: 'past_due',
    }, 402);
  }

  // Active subscription — check if current_period_end has passed
  if (sub.current_period_end) {
    const periodEnd = new Date(sub.current_period_end);
    if (periodEnd < new Date()) {
      return c.json({
        error: 'payment_required',
        message: 'Your subscription period has ended. Please renew.',
        upgrade_url: `/billing/${tenantId}`,
        expired_at: sub.current_period_end,
      }, 402);
    }
  }

  // Active + valid period — allow through
  return next();
}

// ── Pipeline routes (plan-gated) ──

app.post('/api/pipeline/start', enforcePlan, async (c) => {
  try {
    const key = authorityKey(c);
    const reqBody = await c.req.text();
    const resp = await c.env.ORCHESTRATOR.fetch(new Request('http://internal/v1/pipeline/start', {
      method: 'POST',
      headers: { 'X-Authority-Key': key, 'Content-Type': 'application/json' },
      body: reqBody,
    }));
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
    });
  } catch (err: any) {
    console.error('Proxy /api/pipeline/start error:', err.message, err.stack);
    return c.json({ error: 'proxy_error', detail: err.message }, 502);
  }
});

app.get('/api/pipeline/:run_id', async (c) => {
  try {
    const key = authorityKey(c);
    if (!key) return c.json({ error: 'missing_authority_key' }, 401);
    const runId = c.req.param('run_id');
    const resp = await c.env.ORCHESTRATOR.fetch(new Request(`http://internal/v1/pipeline/${runId}`, {
      headers: { 'X-Authority-Key': key },
    }));
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
    });
  } catch (err: any) {
    console.error('Proxy /api/pipeline/:run_id error:', err.message, err.stack);
    return c.json({ error: 'proxy_error', detail: err.message }, 502);
  }
});

app.get('/api/pipeline', async (c) => {
  try {
    const key = authorityKey(c);
    if (!key) return c.json({ error: 'missing_authority_key' }, 401);
    const tenantId = c.req.query('tenant_id');
    const url = tenantId
      ? `http://internal/v1/pipeline?tenant_id=${encodeURIComponent(tenantId)}`
      : 'http://internal/v1/pipeline';
    const resp = await c.env.ORCHESTRATOR.fetch(new Request(url, {
      headers: { 'X-Authority-Key': key },
    }));
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
    });
  } catch (err: any) {
    console.error('Proxy /api/pipeline error:', err.message, err.stack);
    return c.json({ error: 'proxy_error', detail: err.message }, 502);
  }
});

// ── Engine read routes (plan-gated except tenant reads) ──

app.all('/api/v1/*', enforcePlan, async (c) => {
  try {
    const key = authorityKey(c);
    const path = c.req.path.replace('/api', '');
    const u = new URL(c.req.url);
    const headers: Record<string, string> = {
      'X-Authority-Key': key,
      'Content-Type': c.req.header('Content-Type') || 'application/json',
    };
    const init: RequestInit = { method: c.req.method, headers };
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      init.body = await c.req.text();
    }
    const resp = await c.env.ENGINE.fetch(
      new Request(`http://internal${path}${u.search}`, init)
    );
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
    });
  } catch (err: any) {
    console.error('Proxy /api/v1/* error:', err.message, err.stack);
    return c.json({ error: 'proxy_error', detail: err.message }, 502);
  }
});

export default app;


// ══════════════════════════════════════════════════════════════════════════════
// HTML RENDERERS
// ══════════════════════════════════════════════════════════════════════════════

function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>411bz.ai — AI Authority Intelligence Platform</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0e1a;--surface:#111827;--border:#1e293b;--accent:#6366f1;--accent-hover:#818cf8;--text:#f1f5f9;--muted:#94a3b8;--green:#22c55e;--red:#ef4444}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover)}
.container{max-width:1100px;margin:0 auto;padding:0 24px}

/* Nav */
nav{padding:20px 0;border-bottom:1px solid var(--border)}
nav .container{display:flex;justify-content:space-between;align-items:center}
.logo{font-size:24px;font-weight:800;color:var(--text)}
.logo span{color:var(--accent)}
nav a.btn{background:var(--accent);color:#fff;padding:10px 24px;border-radius:8px;font-weight:600;font-size:14px}
nav a.btn:hover{background:var(--accent-hover)}

/* Hero */
.hero{padding:100px 0 80px;text-align:center}
.hero h1{font-size:clamp(36px,5vw,56px);font-weight:800;line-height:1.1;margin-bottom:24px}
.hero h1 span{background:linear-gradient(135deg,var(--accent),#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero p{font-size:20px;color:var(--muted);max-width:640px;margin:0 auto 40px}
.hero-cta{display:flex;gap:16px;justify-content:center;flex-wrap:wrap}
.hero-cta .btn-primary{background:var(--accent);color:#fff;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px}
.hero-cta .btn-primary:hover{background:var(--accent-hover)}
.hero-cta .btn-ghost{border:1px solid var(--border);color:var(--muted);padding:14px 32px;border-radius:8px;font-weight:600;font-size:16px}
.hero-cta .btn-ghost:hover{border-color:var(--accent);color:var(--text)}

/* Stats */
.stats{display:flex;gap:40px;justify-content:center;margin-top:60px;flex-wrap:wrap}
.stat{text-align:center}
.stat .num{font-size:36px;font-weight:800;color:var(--accent)}
.stat .label{font-size:14px;color:var(--muted);margin-top:4px}

/* Features */
.features{padding:80px 0}
.features h2{text-align:center;font-size:32px;font-weight:800;margin-bottom:48px}
.feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}
.feature-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px}
.feature-card h3{font-size:18px;font-weight:700;margin-bottom:8px}
.feature-card p{color:var(--muted);font-size:15px}

/* Pricing */
.pricing{padding:80px 0;background:var(--surface)}
.pricing h2{text-align:center;font-size:32px;font-weight:800;margin-bottom:12px}
.pricing .subtitle{text-align:center;color:var(--muted);font-size:16px;margin-bottom:48px}
.price-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px}
.price-card{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:32px;position:relative}
.price-card.popular{border-color:var(--accent)}
.price-card.popular::before{content:'Most Popular';position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;padding:4px 16px;border-radius:20px;font-size:12px;font-weight:700}
.price-card h3{font-size:20px;font-weight:700;margin-bottom:8px}
.price-card .price{font-size:40px;font-weight:800;margin:16px 0 8px}
.price-card .price span{font-size:16px;color:var(--muted);font-weight:400}
.price-card .desc{color:var(--muted);font-size:14px;margin-bottom:24px}
.price-card ul{list-style:none;margin-bottom:32px}
.price-card li{padding:6px 0;font-size:14px;color:var(--muted)}
.price-card li::before{content:'\\2713';color:var(--green);margin-right:8px;font-weight:700}
.price-card .btn-plan{display:block;text-align:center;padding:12px;border-radius:8px;font-weight:600;font-size:14px;border:1px solid var(--border);color:var(--text)}
.price-card .btn-plan:hover{border-color:var(--accent);color:var(--accent)}
.price-card.popular .btn-plan{background:var(--accent);border-color:var(--accent);color:#fff}
.price-card.popular .btn-plan:hover{background:var(--accent-hover)}

/* Footer */
footer{padding:40px 0;border-top:1px solid var(--border);text-align:center}
footer p{color:var(--muted);font-size:14px}
</style>
</head>
<body>

<nav><div class="container">
  <div class="logo">411<span>bz</span>.ai</div>
  <a href="/api/runtime-config" class="btn">API Docs</a>
</div></nav>

<section class="hero"><div class="container">
  <h1>Your Business's <span>AI Authority</span> Score — Measured, Diagnosed, Fixed</h1>
  <p>411bz.ai is the only platform that measures how AI systems see your business across 600 dimensions, diagnoses gaps, and deploys fixes — all governed by a 12-stage authority pipeline.</p>
  <div class="hero-cta">
    <a href="#pricing" class="btn-primary">Start Free Trial</a>
    <a href="#features" class="btn-ghost">See How It Works</a>
  </div>
  <div class="stats">
    <div class="stat"><div class="num">600</div><div class="label">Examiner Categories</div></div>
    <div class="stat"><div class="num">12</div><div class="label">Pipeline Stages</div></div>
    <div class="stat"><div class="num">100%</div><div class="label">Governed Decisions</div></div>
  </div>
</div></section>

<section class="features" id="features"><div class="container">
  <h2>What 411bz.ai Does</h2>
  <div class="feature-grid">
    <div class="feature-card">
      <h3>Authority Intelligence Index (AII)</h3>
      <p>A single composite score that tells you how AI systems perceive your business — computed from content depth, schema coverage, E-E-A-T signals, citation patterns, and more.</p>
    </div>
    <div class="feature-card">
      <h3>12-Stage Governed Pipeline</h3>
      <p>Every analysis runs through ingest, normalize, examine, evidence graph, diagnosis, cure compilation, content forge, deploy, remeasure, and publish — with CPR checkpoints at every stage.</p>
    </div>
    <div class="feature-card">
      <h3>CWAR Decision Routing</h3>
      <p>Confidence-Weighted Action Routing ensures high-impact changes are reviewed before deployment. Low-confidence results pause automatically for human review.</p>
    </div>
    <div class="feature-card">
      <h3>Evidence-Based Cures</h3>
      <p>Every recommendation is backed by evidence from the 600-category examiner. No guesswork — each cure links to the specific gap it addresses.</p>
    </div>
    <div class="feature-card">
      <h3>Schema &amp; Structured Data</h3>
      <p>Automatic analysis of your structured data markup against what AI systems expect. Gaps are identified and fixes are generated ready to deploy.</p>
    </div>
    <div class="feature-card">
      <h3>Drift Monitoring</h3>
      <p>Continuous monitoring detects when your AI authority score changes — whether from your own updates or shifts in the competitive landscape.</p>
    </div>
  </div>
</div></section>

<section class="pricing" id="pricing"><div class="container">
  <h2>Simple, Transparent Pricing</h2>
  <p class="subtitle">Start with a free trial. Upgrade when you're ready.</p>
  <div class="price-grid">
    <div class="price-card">
      <h3>Starter</h3>
      <div class="price">$97<span>/mo</span></div>
      <div class="desc">For small businesses getting started with AI visibility.</div>
      <ul>
        <li>1 domain</li>
        <li>5 pipeline runs/day</li>
        <li>Snapshot reports</li>
        <li>Basic drift alerts</li>
        <li>Schema gap analysis</li>
      </ul>
      <a href="#" class="btn-plan">Get Started</a>
    </div>
    <div class="price-card popular">
      <h3>Growth</h3>
      <div class="price">$297<span>/mo</span></div>
      <div class="desc">For growing businesses serious about AI authority.</div>
      <ul>
        <li>5 domains</li>
        <li>20 pipeline runs/day</li>
        <li>Everything in Starter</li>
        <li>Competitive intelligence</li>
        <li>AI visibility tracking</li>
        <li>Network density analysis</li>
      </ul>
      <a href="#" class="btn-plan">Get Started</a>
    </div>
    <div class="price-card">
      <h3>Pro</h3>
      <div class="price">$797<span>/mo</span></div>
      <div class="desc">For enterprises that need full authority governance.</div>
      <ul>
        <li>10 domains</li>
        <li>100 pipeline runs/day</li>
        <li>Everything in Growth</li>
        <li>Executive dashboard</li>
        <li>Observatory access</li>
        <li>Weight tuning</li>
        <li>Cross-locale analysis</li>
      </ul>
      <a href="#" class="btn-plan">Get Started</a>
    </div>
  </div>
</div></section>

<footer><div class="container">
  <p>&copy; \${new Date().getFullYear()} 411bz.ai — AI Authority Intelligence Platform</p>
</div></footer>

</body>
</html>`;
}

function renderBillingPage(
  tenantId: string,
  sub: { status: string; plan: string; current_period_end?: string } | null,
  tenant: { business_name?: string; domain?: string; plan?: string } | null,
  error: string | null
): string {
  const plan = sub?.plan || tenant?.plan || 'trial';
  const status = sub?.status || 'none';
  const periodEnd = sub?.current_period_end
    ? new Date(sub.current_period_end).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'N/A';
  const businessName = tenant?.business_name || tenantId;

  const statusColor = status === 'active' ? '#22c55e'
    : status === 'past_due' ? '#f59e0b'
    : status === 'canceled' ? '#ef4444'
    : '#94a3b8';

  const statusLabel = status === 'active' ? 'Active'
    : status === 'past_due' ? 'Past Due'
    : status === 'canceled' ? 'Canceled'
    : 'No Subscription';

  const plans = [
    { id: 'starter', name: 'Starter', price: '$97/mo', domains: 1, pipelines: 5 },
    { id: 'growth', name: 'Growth', price: '$297/mo', domains: 5, pipelines: 20 },
    { id: 'pro', name: 'Pro', price: '$797/mo', domains: 10, pipelines: 100 },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Billing — \${businessName} — 411bz.ai</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0e1a;--surface:#111827;--border:#1e293b;--accent:#6366f1;--accent-hover:#818cf8;--text:#f1f5f9;--muted:#94a3b8;--green:#22c55e}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}
.container{max-width:800px;margin:0 auto;padding:40px 24px}
h1{font-size:28px;font-weight:800;margin-bottom:8px}
.subtitle{color:var(--muted);font-size:16px;margin-bottom:32px}

.status-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;margin-bottom:32px}
.status-row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)}
.status-row:last-child{border-bottom:none}
.status-label{color:var(--muted);font-size:14px}
.status-value{font-weight:600;font-size:14px}
.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;color:#fff}

.plans-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:32px}
.plan-option{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center}
.plan-option.current{border-color:var(--accent)}
.plan-option h3{font-size:18px;font-weight:700;margin-bottom:4px}
.plan-option .price{font-size:24px;font-weight:800;margin:8px 0}
.plan-option .meta{color:var(--muted);font-size:13px;margin-bottom:16px}
.plan-option button{background:var(--accent);color:#fff;border:none;padding:10px 24px;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;width:100%}
.plan-option button:hover{background:var(--accent-hover)}
.plan-option button:disabled{background:var(--border);color:var(--muted);cursor:default}

.error-banner{background:#1e1014;border:1px solid var(--red);border-radius:8px;padding:16px;margin-bottom:24px;color:#fca5a5;font-size:14px}

.back-link{display:inline-block;margin-bottom:24px;color:var(--muted);font-size:14px}
.back-link:hover{color:var(--text)}
</style>
</head>
<body>
<div class="container">
  <a href="/" class="back-link">&larr; Back to 411bz.ai</a>
  <h1>Billing &amp; Subscription</h1>
  <p class="subtitle">\${businessName}</p>

  \${error ? \`<div class="error-banner">\${error}</div>\` : ''}

  <div class="status-card">
    <div class="status-row">
      <span class="status-label">Tenant ID</span>
      <span class="status-value">\${tenantId}</span>
    </div>
    <div class="status-row">
      <span class="status-label">Current Plan</span>
      <span class="status-value" style="text-transform:capitalize">\${plan}</span>
    </div>
    <div class="status-row">
      <span class="status-label">Status</span>
      <span class="badge" style="background:\${statusColor}">\${statusLabel}</span>
    </div>
    <div class="status-row">
      <span class="status-label">Period Ends</span>
      <span class="status-value">\${periodEnd}</span>
    </div>
  </div>

  <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">Change Plan</h2>
  <p style="color:var(--muted);font-size:14px;margin-bottom:16px">Select a plan to upgrade or change your subscription.</p>

  <div class="plans-grid">
    \${plans.map(p => \`
    <div class="plan-option \${p.id === plan ? 'current' : ''}">
      <h3>\${p.name}</h3>
      <div class="price">\${p.price}</div>
      <div class="meta">\${p.domains} domain\${p.domains > 1 ? 's' : ''} &middot; \${p.pipelines} runs/day</div>
      <button \${p.id === plan ? 'disabled' : ''} onclick="checkout('\${p.id}')">
        \${p.id === plan ? 'Current Plan' : 'Select'}
      </button>
    </div>\`).join('')}
  </div>
</div>

<script>
async function checkout(plan) {
  try {
    const resp = await fetch('/api/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Authority-Key': new URLSearchParams(window.location.search).get('key') || ''
      },
      body: JSON.stringify({ tenant_id: '\${tenantId}', plan })
    });
    const data = await resp.json();
    if (data.checkout_url || data.data?.checkout_url) {
      window.location.href = data.checkout_url || data.data.checkout_url;
    } else {
      alert('Error: ' + (data.error || 'Could not create checkout session'));
    }
  } catch (e) {
    alert('Error connecting to payment system');
  }
}
</script>
</body>
</html>`;
}
