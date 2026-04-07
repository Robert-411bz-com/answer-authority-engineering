/**
 * 411bz-frontend — User-facing API gateway + marketing surface.
 * Phase 4: Tenant-scoped authentication (HMAC tokens + cookies).
 * Builds on Phase 3 (onboarding, dashboard, rate limiting).
 *
 * AUTH MODEL:
 *   - Service-to-service: X-Authority-Key header (unchanged)
 *   - Browser sessions: __411bz_token HttpOnly cookie (NEW)
 *   - /dashboard/:tid and /billing/:tid require cookie auth
 *   - /api/* routes still use X-Authority-Key (E2E tests unaffected)
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
import {
  generateToken, verifyToken, parseCookie, setTokenCookie,
  clearTokenCookie, generateAuthCode,
  type TokenPayload,
} from './auth';

type Bindings = {
  ENGINE: Fetcher;
  ORCHESTRATOR: Fetcher;
  OBSERVATORY: Fetcher;
  BOSS_AI: Fetcher;
  STRIPE: Fetcher;
  WORKER_ID: string;
  AUTHORITY_INTERNAL_KEY: string;
  FRONTEND_HOST: string;
  TOKEN_SIGNING_SECRET: string;
  // Observatory D1 for auth_codes + sessions (shared with 411bz-stripe)
  DB: D1Database;
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

async function extractTenantId(c: any): Promise<string | null> {
  const pathMatch = c.req.path.match(/\/api\/v1\/(?:tenants|evidence|scorecards)\/([^/]+)/);
  if (pathMatch) return pathMatch[1];
  const qTenant = c.req.query('tenant_id');
  if (qTenant) return qTenant;
  if (c.req.method === 'POST') {
    try {
      const clone = c.req.raw.clone();
      const body = await clone.json();
      if (body?.tenant_id) return body.tenant_id;
    } catch {}
  }
  return null;
}

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

const PLAN_LIMITS: Record<string, { max_pipelines_per_day: number; max_domains: number }> = {
  trial:   { max_pipelines_per_day: 1, max_domains: 1 },
  starter: { max_pipelines_per_day: 5, max_domains: 1 },
  growth:  { max_pipelines_per_day: 20, max_domains: 5 },
  pro:     { max_pipelines_per_day: 100, max_domains: 10 },
};

// ══════════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ══════════════════════════════════════════════════════════════════════════════

const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMITS = {
  unauthenticated: { max: 60, windowMs: 60_000 },
  authenticated: { max: 120, windowMs: 60_000 },
  pipeline: { max: 10, windowMs: 60_000 },
};

function checkRateLimit(key: string, limit: { max: number; windowMs: number }): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || (now - entry.windowStart) > limit.windowMs) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  if (entry.count > limit.max) return false;
  return true;
}

let rlCleanCounter = 0;
function rlCleanup() {
  if (++rlCleanCounter % 100 !== 0) return;
  const now = Date.now();
  for (const [k, v] of rateLimitMap) {
    if (now - v.windowStart > 120_000) rateLimitMap.delete(k);
  }
}

async function rateLimit(c: any, next: () => Promise<void>): Promise<Response | void> {
  rlCleanup();
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const path = c.req.path;
  if (path === '/api/pipeline/start') {
    const tenantId = await extractTenantId(c);
    const key = tenantId ? `pl:${tenantId}` : `pl:${ip}`;
    if (!checkRateLimit(key, RATE_LIMITS.pipeline)) {
      return c.json({ error: 'rate_limit_exceeded', message: 'Too many pipeline requests. Max 10/min.' }, 429);
    }
    return next();
  }
  if (path.startsWith('/api/')) {
    const tenantId = await extractTenantId(c);
    const key = tenantId ? `api:${tenantId}` : `api:${ip}`;
    if (!checkRateLimit(key, RATE_LIMITS.authenticated)) {
      return c.json({ error: 'rate_limit_exceeded', message: 'Too many API requests. Max 120/min.' }, 429);
    }
    return next();
  }
  if (!checkRateLimit(`pub:${ip}`, RATE_LIMITS.unauthenticated)) {
    return c.json({ error: 'rate_limit_exceeded', message: 'Too many requests. Please slow down.' }, 429);
  }
  return next();
}

// ══════════════════════════════════════════════════════════════════════════════
// TENANT AUTH MIDDLEWARE (cookie-based, for browser routes only)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Validates __411bz_token cookie and ensures token.tid matches :tenant_id.
 * On failure: redirects to /login with redirect param.
 * On success: sets c.set('auth', payload) for downstream handlers.
 *
 * SPECIAL CASE: If ?auth_code= is present, exchange it for a cookie first.
 */
async function requireTenantAuth(c: any, next: () => Promise<void>): Promise<Response | void> {
  const tenantId = c.req.param('tenant_id');
  const secret = c.env.TOKEN_SIGNING_SECRET;

  // If TOKEN_SIGNING_SECRET is not set, fall back to open access (beta mode)
  // WARNING: This allows unauthenticated access. Set TOKEN_SIGNING_SECRET to activate auth.
  if (!secret) {
    console.warn('TOKEN_SIGNING_SECRET not set — auth disabled (beta mode). Set secret to activate.');
    c.set('auth', { tid: tenantId, uid: 'anonymous', role: 'viewer', exp: 0 });
    return next();
  }

  // Check for auth_code query param (one-time code from magic link)
  const authCode = c.req.query('auth_code');
  if (authCode) {
    const exchangeResult = await exchangeAuthCode(c.env, authCode, secret);
    if (exchangeResult) {
      const url = new URL(c.req.url);
      url.searchParams.delete('auth_code');
      const cleanUrl = url.pathname + (url.search || '');
      return new Response(null, {
        status: 302,
        headers: {
          'Location': cleanUrl,
          'Set-Cookie': setTokenCookie(exchangeResult.token),
        },
      });
    }
    // Invalid code — fall through to cookie check
  }

  // Check for session_id query param (Stripe checkout redirect)
  // Stripe replaces {CHECKOUT_SESSION_ID} in success_url automatically
  const sessionId = c.req.query('session_id');
  if (sessionId) {
    const exchangeResult = await exchangeStripeSession(c.env, sessionId, secret);
    if (exchangeResult) {
      const url = new URL(c.req.url);
      url.searchParams.delete('session_id');
      // Keep ?welcome=true if present
      const cleanUrl = url.pathname + (url.search || '');
      return new Response(null, {
        status: 302,
        headers: {
          'Location': cleanUrl,
          'Set-Cookie': setTokenCookie(exchangeResult.token),
        },
      });
    }
    // Session not found yet (webhook may lag) — fall through to cookie check
  }

  // Check cookie
  const cookieHeader = c.req.header('cookie');
  const token = parseCookie(cookieHeader);

  if (!token) {
    return redirectToLogin(c.req.url, tenantId);
  }

  const result = await verifyToken(token, secret);

  if (!result.valid) {
    // Clear stale cookie and redirect
    return new Response(null, {
      status: 302,
      headers: {
        'Location': `/login?redirect=${encodeURIComponent(c.req.path)}&reason=${result.reason}`,
        'Set-Cookie': clearTokenCookie(),
      },
    });
  }

  // Tenant isolation: token.tid must match URL :tenant_id
  if (result.payload.tid !== tenantId) {
    return new Response(null, {
      status: 302,
      headers: {
        'Location': `/dashboard/${result.payload.tid}`,
      },
    });
  }

  // Auth passed — make payload available to handler
  c.set('auth', result.payload);
  return next();
}

function redirectToLogin(requestUrl: string, tenantId: string): Response {
  const path = new URL(requestUrl).pathname;
  return new Response(null, {
    status: 302,
    headers: { 'Location': `/login?redirect=${encodeURIComponent(path)}` },
  });
}

async function exchangeAuthCode(
  env: Bindings,
  code: string,
  signingSecret: string
): Promise<{ token: string; tenantId: string } | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT code, tenant_id, user_id, purpose, expires_at, used
       FROM auth_codes WHERE code = ?`
    ).bind(code).first<{
      code: string; tenant_id: string; user_id: string;
      purpose: string; expires_at: string; used: number;
    }>();

    if (!row || row.used) return null;

    // Check expiry
    if (new Date(row.expires_at) < new Date()) return null;

    // Validate purpose (only checkout and magic_link codes can be exchanged)
    if (row.purpose !== 'checkout' && row.purpose !== 'magic_link') return null;

    // Atomically mark as used — returns 0 changes if already used (race-safe)
    const updateResult = await env.DB.prepare(
      'UPDATE auth_codes SET used = 1 WHERE code = ? AND used = 0'
    ).bind(code).run();
    if (!updateResult.meta.changes) return null; // Another request already consumed this code

    // Look up user role
    const VALID_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
    let role = 'viewer'; // fail-safe: lowest privilege
    try {
      const user = await env.DB.prepare(
        'SELECT role FROM observatory_tenant_users WHERE id = ?'
      ).bind(row.user_id).first<{ role: string }>();
      if (user && VALID_ROLES.includes(user.role)) role = user.role;
    } catch {
      console.error('Failed to look up user role for', row.user_id);
    }

    // Generate token
    const token = await generateToken(
      { tid: row.tenant_id, uid: row.user_id, role },
      signingSecret
    );

    // Log session
    try {
      await env.DB.prepare(
        `INSERT INTO observatory_sessions (id, tenant_id, user_id, started_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).bind(crypto.randomUUID(), row.tenant_id, row.user_id).run();
    } catch {}

    return { token, tenantId: row.tenant_id };
  } catch (err) {
    console.error('exchangeAuthCode error:', err);
    return null;
  }
}

/**
 * Exchange a Stripe Checkout Session ID for a tenant auth cookie.
 * The Stripe webhook writes an auth_codes row with stripe_checkout_session_id
 * when checkout.session.completed fires. The browser then exchanges it here.
 */
async function exchangeStripeSession(
  env: Bindings,
  stripeSessionId: string,
  signingSecret: string
): Promise<{ token: string; tenantId: string } | null> {
  try {
    // Look up auth_code by stripe_checkout_session_id
    const row = await env.DB.prepare(
      `SELECT code, tenant_id, user_id, purpose, expires_at, used
       FROM auth_codes WHERE stripe_checkout_session_id = ?`
    ).bind(stripeSessionId).first<{
      code: string; tenant_id: string; user_id: string;
      purpose: string; expires_at: string; used: number;
    }>();

    if (!row) return null; // Webhook hasn't fired yet or session_id invalid
    if (row.used) return null; // Already exchanged

    // Check expiry
    if (new Date(row.expires_at) < new Date()) return null;

    // Atomically mark as used (race-safe)
    const updateResult = await env.DB.prepare(
      'UPDATE auth_codes SET used = 1 WHERE code = ? AND used = 0'
    ).bind(row.code).run();
    if (!updateResult.meta.changes) return null;

    // Look up user role
    const VALID_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
    let role = 'viewer';
    try {
      const user = await env.DB.prepare(
        'SELECT role FROM observatory_tenant_users WHERE id = ?'
      ).bind(row.user_id).first<{ role: string }>();
      if (user && VALID_ROLES.includes(user.role)) role = user.role;
    } catch {
      console.error('Failed to look up user role for', row.user_id);
    }

    const token = await generateToken(
      { tid: row.tenant_id, uid: row.user_id, role },
      signingSecret
    );

    // Log session
    try {
      await env.DB.prepare(
        `INSERT INTO observatory_sessions (id, tenant_id, user_id, started_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).bind(crypto.randomUUID(), row.tenant_id, row.user_id).run();
    } catch {}

    return { token, tenantId: row.tenant_id };
  } catch (err) {
    console.error('exchangeStripeSession error:', err);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════════

app.use('/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use('/*', rateLimit);

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES (no auth)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

app.get('/', (c) => c.html(renderLandingPage()));

app.get('/onboard', (c) => {
  const preselectedPlan = c.req.query('plan') || '';
  const canceled = c.req.query('canceled') === 'true';
  return c.html(renderOnboardingPage(preselectedPlan, canceled));
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES (login, verify, logout)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/login', (c) => {
  const redirect = c.req.query('redirect') || '';
  const reason = c.req.query('reason') || '';
  return c.html(renderLoginPage(redirect, reason));
});

app.post('/api/auth/magic-link', async (c) => {
  try {
    const body = await c.req.json<{ email: string; redirect?: string }>();
    const email = body.email?.trim().toLowerCase();
    if (!email) return c.json({ error: 'email_required' }, 400);

    // Look up user — don't reveal whether email exists
    const user = await c.env.DB.prepare(
      'SELECT id, tenant_id, role FROM observatory_tenant_users WHERE email = ? LIMIT 1'
    ).bind(email).first<{ id: string; tenant_id: string; role: string }>();

    if (user) {
      // Generate auth code
      const code = generateAuthCode();
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

      await c.env.DB.prepare(
        `INSERT INTO auth_codes (code, tenant_id, user_id, purpose, expires_at)
         VALUES (?, ?, ?, 'magic_link', ?)`
      ).bind(code, user.tenant_id, user.id, expiresAt).run();

      // Build magic link
      const host = c.env.FRONTEND_HOST || c.req.header('host') || '411bz.ai';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const redirectPath = body.redirect || `/dashboard/${user.tenant_id}`;
      const magicUrl = `${protocol}://${host}/auth/verify?code=${code}&redirect=${encodeURIComponent(redirectPath)}`;

      // TODO: Send email via Resend/Mailgun. For now, log the link.
      // In production, replace this with:
      //   await fetch('https://api.resend.com/emails', {
      //     method: 'POST',
      //     headers: { 'Authorization': `Bearer ${c.env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
      //     body: JSON.stringify({
      //       from: c.env.EMAIL_FROM || 'noreply@411bz.ai',
      //       to: email,
      //       subject: 'Your 411bz.ai login link',
      //       html: `<p>Click to log in: <a href="${magicUrl}">${magicUrl}</a></p><p>This link expires in 15 minutes.</p>`
      //     })
      //   });
      console.log(`[MAGIC_LINK] email=${email} url=${magicUrl}`);
    }

    // Always return success (prevent email enumeration)
    return c.json({ ok: true, message: 'If an account exists for that email, a login link has been sent.' });
  } catch (err: any) {
    console.error('Magic link error:', err.message);
    return c.json({ error: 'internal_error' }, 500);
  }
});

app.get('/auth/verify', async (c) => {
  const code = c.req.query('code');
  const redirect = c.req.query('redirect') || '/';

  if (!code) {
    return c.html(renderLoginPage('', 'missing_code'));
  }

  const secret = c.env.TOKEN_SIGNING_SECRET;
  if (!secret) {
    return c.redirect(redirect);
  }

  const result = await exchangeAuthCode(c.env, code, secret);
  if (!result) {
    return c.html(renderLoginPage(redirect, 'invalid_or_expired_code'));
  }

  // Set cookie and redirect
  return new Response(null, {
    status: 302,
    headers: {
      'Location': redirect,
      'Set-Cookie': setTokenCookie(result.token),
    },
  });
});

app.post('/auth/logout', async (c) => {
  // End session if we can read the token
  const secret = c.env.TOKEN_SIGNING_SECRET;
  if (secret) {
    const cookieHeader = c.req.header('cookie');
    const token = parseCookie(cookieHeader);
    if (token) {
      const result = await verifyToken(token, secret);
      if (result.valid) {
        try {
          await c.env.DB.prepare(
            `UPDATE observatory_sessions SET ended_at = datetime('now')
             WHERE user_id = ? AND ended_at IS NULL`
          ).bind(result.payload.uid).run();
        } catch {}
      }
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': clearTokenCookie(),
    },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PROTECTED BROWSER ROUTES (require tenant auth cookie)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/dashboard/:tenant_id', requireTenantAuth, async (c) => {
  const tenantId = c.req.param('tenant_id');
  const auth = c.get('auth') as TokenPayload;
  const key = authorityKey(c);
  return c.html(renderDashboardPage(tenantId, key, auth));
});

app.get('/billing/:tenant_id', requireTenantAuth, async (c) => {
  const tenantId = c.req.param('tenant_id');
  const auth = c.get('auth') as TokenPayload;
  const key = authorityKey(c);

  const sub = await getSubscription(c.env, tenantId, key);

  let tenant: any = null;
  try {
    const resp = await c.env.ENGINE.fetch(new Request(`http://internal/v1/tenants/${tenantId}`, {
      headers: { 'X-Authority-Key': key },
    }));
    if (resp.ok) {
      const data = await resp.json() as any;
      tenant = data?.data || data;
    }
  } catch {}

  return c.html(renderBillingPage(tenantId, sub, tenant, null, auth));
});

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES (X-Authority-Key auth — unchanged from Phase 3)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/runtime-config', (c) => {
  return c.json(wrapTruth({
    platform: '411bz.ai',
    version: '4.0.0',
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
      onboard: '/onboard',
      dashboard: '/dashboard/:tenant_id',
      login: '/login',
    },
  }, c.env.WORKER_ID, generateRequestId()));
});

// Checkout + subscription (no plan check)
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

// Tenant creation (no plan check)
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

// ── Plan enforcement middleware ──
async function enforcePlan(c: any, next: () => Promise<void>): Promise<Response | void> {
  const key = authorityKey(c);
  if (!key) return c.json({ error: 'missing_authority_key' }, 401);
  if (c.req.path === '/api/v1/subscriptions' && c.req.method === 'POST') return next();
  const tenantId = await extractTenantId(c);
  if (!tenantId) return next();
  const sub = await getSubscription(c.env, tenantId, key);
  if (!sub || sub.status === 'none') {
    return c.json({ error: 'payment_required', message: 'No active subscription.', upgrade_url: `/billing/${tenantId}` }, 402);
  }
  if (sub.status === 'canceled') {
    return c.json({ error: 'payment_required', message: 'Subscription canceled.', upgrade_url: `/billing/${tenantId}` }, 402);
  }
  if (sub.status === 'past_due') {
    return c.json({ error: 'payment_required', message: 'Payment past due.', upgrade_url: `/billing/${tenantId}` }, 402);
  }
  if (sub.current_period_end && new Date(sub.current_period_end) < new Date()) {
    return c.json({ error: 'payment_required', message: 'Subscription expired.', upgrade_url: `/billing/${tenantId}` }, 402);
  }
  return next();
}

// Pipeline routes (plan-gated)
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
    return new Response(body, { status: resp.status, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' } });
  } catch (err: any) {
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
    return new Response(body, { status: resp.status, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' } });
  } catch (err: any) {
    return c.json({ error: 'proxy_error', detail: err.message }, 502);
  }
});

app.get('/api/pipeline', async (c) => {
  try {
    const key = authorityKey(c);
    if (!key) return c.json({ error: 'missing_authority_key' }, 401);
    const tenantId = c.req.query('tenant_id');
    const url = tenantId ? `http://internal/v1/pipeline?tenant_id=${encodeURIComponent(tenantId)}` : 'http://internal/v1/pipeline';
    const resp = await c.env.ORCHESTRATOR.fetch(new Request(url, { headers: { 'X-Authority-Key': key } }));
    const body = await resp.text();
    return new Response(body, { status: resp.status, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' } });
  } catch (err: any) {
    return c.json({ error: 'proxy_error', detail: err.message }, 502);
  }
});

// Engine catch-all (plan-gated)
app.all('/api/v1/*', enforcePlan, async (c) => {
  try {
    const key = authorityKey(c);
    const path = c.req.path.replace('/api', '');
    const u = new URL(c.req.url);
    const headers: Record<string, string> = { 'X-Authority-Key': key, 'Content-Type': c.req.header('Content-Type') || 'application/json' };
    const init: RequestInit = { method: c.req.method, headers };
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') { init.body = await c.req.text(); }
    const resp = await c.env.ENGINE.fetch(new Request(`http://internal${path}${u.search}`, init));
    const body = await resp.text();
    return new Response(body, { status: resp.status, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' } });
  } catch (err: any) {
    return c.json({ error: 'proxy_error', detail: err.message }, 502);
  }
});

export default app;


// ══════════════════════════════════════════════════════════════════════════════
// SHARED STYLES
// ══════════════════════════════════════════════════════════════════════════════

const SHARED_STYLES = `
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0e1a;--surface:#111827;--border:#1e293b;--accent:#6366f1;--accent-hover:#818cf8;--text:#f1f5f9;--muted:#94a3b8;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover)}
.container{max-width:1100px;margin:0 auto;padding:0 24px}
`;

const NAV_HTML = `
<nav style="padding:20px 0;border-bottom:1px solid var(--border)">
<div class="container" style="display:flex;justify-content:space-between;align-items:center">
  <a href="/" style="font-size:24px;font-weight:800;color:var(--text);text-decoration:none">411<span style="color:var(--accent)">bz</span>.ai</a>
  <div style="display:flex;gap:16px;align-items:center">
    <a href="/login" style="color:var(--muted);font-size:14px;font-weight:600">Log In</a>
    <a href="/onboard" style="background:var(--accent);color:#fff;padding:10px 24px;border-radius:8px;font-weight:600;font-size:14px">Sign Up</a>
  </div>
</div>
</nav>`;

function authedNavHtml(auth: TokenPayload | null): string {
  if (!auth || auth.uid === 'anonymous') return NAV_HTML;
  return `
<nav style="padding:20px 0;border-bottom:1px solid var(--border)">
<div class="container" style="display:flex;justify-content:space-between;align-items:center">
  <a href="/" style="font-size:24px;font-weight:800;color:var(--text);text-decoration:none">411<span style="color:var(--accent)">bz</span>.ai</a>
  <div style="display:flex;gap:16px;align-items:center">
    <a href="/dashboard/${auth.tid}" style="color:var(--muted);font-size:14px;font-weight:600">Dashboard</a>
    <a href="/billing/${auth.tid}" style="color:var(--muted);font-size:14px;font-weight:600">Billing</a>
    <form action="/auth/logout" method="POST" style="margin:0">
      <button type="submit" style="background:transparent;border:1px solid var(--border);color:var(--muted);padding:8px 16px;border-radius:8px;font-size:13px;cursor:pointer">Log Out</button>
    </form>
  </div>
</div>
</nav>`;
}


// ══════════════════════════════════════════════════════════════════════════════
// LOGIN PAGE
// ══════════════════════════════════════════════════════════════════════════════

function renderLoginPage(redirect: string, reason: string): string {
  const reasonMessages: Record<string, string> = {
    expired: 'Your session has expired. Please log in again.',
    invalid_signature: 'Your session is invalid. Please log in again.',
    missing_code: 'No login code provided.',
    invalid_or_expired_code: 'That login link has expired or was already used. Please request a new one.',
  };
  const message = reasonMessages[reason] || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log In — 411bz.ai</title>
<style>
${SHARED_STYLES}
.login-wrap{max-width:440px;margin:0 auto;padding:80px 24px}
h1{font-size:28px;font-weight:800;margin-bottom:8px}
.subtitle{color:var(--muted);font-size:15px;margin-bottom:32px}
.form-group{margin-bottom:20px}
.form-group label{display:block;font-size:14px;font-weight:600;margin-bottom:6px;color:var(--muted)}
.form-group input{width:100%;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:15px;outline:none}
.form-group input:focus{border-color:var(--accent)}
.btn-submit{background:var(--accent);color:#fff;border:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px;cursor:pointer;width:100%}
.btn-submit:hover{background:var(--accent-hover)}
.btn-submit:disabled{background:var(--border);color:var(--muted);cursor:default}
.alert{padding:14px 16px;border-radius:8px;font-size:14px;margin-bottom:24px}
.alert-error{background:#1e1014;border:1px solid var(--red);color:#fca5a5}
.alert-success{background:rgba(34,197,94,0.08);border:1px solid var(--green);color:#86efac}
.back-link{display:inline-block;margin-bottom:24px;color:var(--muted);font-size:14px}
</style>
</head>
<body>
${NAV_HTML}
<div class="login-wrap">
  <a href="/" class="back-link">&larr; Back to 411bz.ai</a>
  <h1>Log in to your dashboard</h1>
  <p class="subtitle">Enter your email and we'll send you a magic link.</p>

  ${message ? `<div class="alert alert-error">${message}</div>` : ''}
  <div class="alert alert-success" id="success-msg" style="display:none">Check your email for a login link.</div>

  <form id="login-form" onsubmit="handleLogin(event)">
    <div class="form-group">
      <label for="email">Email Address</label>
      <input type="email" id="email" name="email" placeholder="you@company.com" required autocomplete="email">
    </div>
    <button type="submit" class="btn-submit" id="btn-login">Send Magic Link</button>
  </form>

  <p style="color:var(--muted);font-size:13px;margin-top:24px;text-align:center">
    Don't have an account? <a href="/onboard">Sign up here</a>
  </p>
</div>
<script>
async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-login');
  const email = document.getElementById('email').value.trim();
  if (!email) return;
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const resp = await fetch('/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, redirect: '${redirect}' })
    });
    document.getElementById('success-msg').style.display = 'block';
    document.getElementById('login-form').style.display = 'none';
  } catch {
    btn.disabled = false;
    btn.textContent = 'Send Magic Link';
  }
}
</script>
</body>
</html>`;
}


// ══════════════════════════════════════════════════════════════════════════════
// LANDING PAGE (unchanged except nav has "Log In" link)
// ══════════════════════════════════════════════════════════════════════════════

function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>411bz.ai — AI Authority Intelligence Platform</title>
<style>
${SHARED_STYLES}
.hero{padding:100px 0 80px;text-align:center}
.hero h1{font-size:clamp(36px,5vw,56px);font-weight:800;line-height:1.1;margin-bottom:24px}
.hero h1 span{background:linear-gradient(135deg,var(--accent),#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero p{font-size:20px;color:var(--muted);max-width:640px;margin:0 auto 40px}
.hero-cta{display:flex;gap:16px;justify-content:center;flex-wrap:wrap}
.hero-cta .btn-primary{background:var(--accent);color:#fff;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px}
.hero-cta .btn-primary:hover{background:var(--accent-hover)}
.hero-cta .btn-ghost{border:1px solid var(--border);color:var(--muted);padding:14px 32px;border-radius:8px;font-weight:600;font-size:16px}
.stats{display:flex;gap:40px;justify-content:center;margin-top:60px;flex-wrap:wrap}
.stat{text-align:center}.stat .num{font-size:36px;font-weight:800;color:var(--accent)}.stat .label{font-size:14px;color:var(--muted);margin-top:4px}
.features{padding:80px 0}.features h2{text-align:center;font-size:32px;font-weight:800;margin-bottom:48px}
.feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}
.feature-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px}
.feature-card h3{font-size:18px;font-weight:700;margin-bottom:8px}.feature-card p{color:var(--muted);font-size:15px}
.pricing{padding:80px 0;background:var(--surface)}.pricing h2{text-align:center;font-size:32px;font-weight:800;margin-bottom:12px}
.pricing .subtitle{text-align:center;color:var(--muted);font-size:16px;margin-bottom:48px}
.price-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px}
.price-card{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:32px;position:relative}
.price-card.popular{border-color:var(--accent)}
.price-card.popular::before{content:'Most Popular';position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;padding:4px 16px;border-radius:20px;font-size:12px;font-weight:700}
.price-card h3{font-size:20px;font-weight:700;margin-bottom:8px}
.price-card .price{font-size:40px;font-weight:800;margin:16px 0 8px}.price-card .price span{font-size:16px;color:var(--muted);font-weight:400}
.price-card .desc{color:var(--muted);font-size:14px;margin-bottom:24px}
.price-card ul{list-style:none;margin-bottom:32px}.price-card li{padding:6px 0;font-size:14px;color:var(--muted)}
.price-card li::before{content:'\\2713';color:var(--green);margin-right:8px;font-weight:700}
.price-card .btn-plan{display:block;text-align:center;padding:12px;border-radius:8px;font-weight:600;font-size:14px;border:1px solid var(--border);color:var(--text)}
.price-card .btn-plan:hover{border-color:var(--accent);color:var(--accent)}
.price-card.popular .btn-plan{background:var(--accent);border-color:var(--accent);color:#fff}
footer{padding:40px 0;border-top:1px solid var(--border);text-align:center}footer p{color:var(--muted);font-size:14px}
</style></head><body>
${NAV_HTML}
<section class="hero"><div class="container">
<h1>Your Business's <span>AI Authority</span> Score — Measured, Diagnosed, Fixed</h1>
<p>411bz.ai is the only platform that measures how AI systems see your business across 600 dimensions, diagnoses gaps, and deploys fixes — all governed by a 12-stage authority pipeline.</p>
<div class="hero-cta"><a href="/onboard" class="btn-primary">Start Free Trial</a><a href="#features" class="btn-ghost">See How It Works</a></div>
<div class="stats"><div class="stat"><div class="num">600</div><div class="label">Examiner Categories</div></div><div class="stat"><div class="num">12</div><div class="label">Pipeline Stages</div></div><div class="stat"><div class="num">100%</div><div class="label">Governed Decisions</div></div></div>
</div></section>
<section class="features" id="features"><div class="container"><h2>What 411bz.ai Does</h2><div class="feature-grid">
<div class="feature-card"><h3>Authority Intelligence Index (AII)</h3><p>A single composite score that tells you how AI systems perceive your business — computed from content depth, schema coverage, E-E-A-T signals, citation patterns, and more.</p></div>
<div class="feature-card"><h3>12-Stage Governed Pipeline</h3><p>Every analysis runs through ingest, normalize, examine, evidence graph, diagnosis, cure compilation, content forge, deploy, remeasure, and publish — with CPR checkpoints at every stage.</p></div>
<div class="feature-card"><h3>CWAR Decision Routing</h3><p>Confidence-Weighted Action Routing ensures high-impact changes are reviewed before deployment. Low-confidence results pause automatically for human review.</p></div>
<div class="feature-card"><h3>Evidence-Based Cures</h3><p>Every recommendation is backed by evidence from the 600-category examiner. No guesswork — each cure links to the specific gap it addresses.</p></div>
<div class="feature-card"><h3>Schema &amp; Structured Data</h3><p>Automatic analysis of your structured data markup against what AI systems expect. Gaps are identified and fixes are generated ready to deploy.</p></div>
<div class="feature-card"><h3>Drift Monitoring</h3><p>Continuous monitoring detects when your AI authority score changes — whether from your own updates or shifts in the competitive landscape.</p></div>
</div></div></section>
<section class="pricing" id="pricing"><div class="container"><h2>Simple, Transparent Pricing</h2><p class="subtitle">Start with a free trial. Upgrade when you're ready.</p><div class="price-grid">
<div class="price-card"><h3>Starter</h3><div class="price">$97<span>/mo</span></div><div class="desc">For small businesses getting started with AI visibility.</div><ul><li>1 domain</li><li>5 pipeline runs/day</li><li>Snapshot reports</li><li>Basic drift alerts</li><li>Schema gap analysis</li></ul><a href="/onboard?plan=starter" class="btn-plan">Get Started</a></div>
<div class="price-card popular"><h3>Growth</h3><div class="price">$297<span>/mo</span></div><div class="desc">For growing businesses serious about AI authority.</div><ul><li>5 domains</li><li>20 pipeline runs/day</li><li>Everything in Starter</li><li>Competitive intelligence</li><li>AI visibility tracking</li><li>Network density analysis</li></ul><a href="/onboard?plan=growth" class="btn-plan">Get Started</a></div>
<div class="price-card"><h3>Pro</h3><div class="price">$797<span>/mo</span></div><div class="desc">For enterprises that need full authority governance.</div><ul><li>10 domains</li><li>100 pipeline runs/day</li><li>Everything in Growth</li><li>Executive dashboard</li><li>Observatory access</li><li>Weight tuning</li><li>Cross-locale analysis</li></ul><a href="/onboard?plan=pro" class="btn-plan">Get Started</a></div>
</div></div></section>
<footer><div class="container"><p>&copy; ${new Date().getFullYear()} 411bz.ai — AI Authority Intelligence Platform</p></div></footer>
</body></html>`;
}


// ══════════════════════════════════════════════════════════════════════════════
// ONBOARDING PAGE — 3-step self-service signup
// Step 1: Business info (domain, name, type)
// Step 2: Plan selection (starter/growth/pro)
// Step 3: Account creation + Stripe checkout redirect
// ══════════════════════════════════════════════════════════════════════════════

function renderOnboardingPage(preselectedPlan: string, canceled: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get Started — 411bz.ai</title>
<style>
${SHARED_STYLES}
.onboard-wrap{max-width:720px;margin:0 auto;padding:60px 24px}
h1{font-size:32px;font-weight:800;margin-bottom:8px}
.subtitle{color:var(--muted);font-size:16px;margin-bottom:32px}
.step{display:none}
.step.active{display:block}
.step-indicator{display:flex;gap:8px;margin-bottom:32px}
.step-dot{width:40px;height:4px;border-radius:2px;background:var(--border)}
.step-dot.active{background:var(--accent)}
.step-dot.done{background:var(--green)}
.form-group{margin-bottom:20px}
.form-group label{display:block;font-size:14px;font-weight:600;margin-bottom:6px;color:var(--muted)}
.form-group input,.form-group select{width:100%;padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:15px;outline:none}
.form-group input:focus,.form-group select:focus{border-color:var(--accent)}
.form-group select{appearance:none;cursor:pointer}
.btn-next{background:var(--accent);color:#fff;border:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px;cursor:pointer;width:100%;margin-top:8px}
.btn-next:hover{background:var(--accent-hover)}
.btn-next:disabled{background:var(--border);color:var(--muted);cursor:default}
.btn-back{background:transparent;color:var(--muted);border:1px solid var(--border);padding:14px 32px;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;width:100%;margin-top:8px}
.btn-back:hover{border-color:var(--accent);color:var(--text)}
.plan-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px}
.plan-card{background:var(--surface);border:2px solid var(--border);border-radius:12px;padding:24px;text-align:center;cursor:pointer;transition:border-color 0.15s}
.plan-card:hover{border-color:var(--accent)}
.plan-card.selected{border-color:var(--accent);background:rgba(99,102,241,0.08)}
.plan-card h3{font-size:18px;font-weight:700;margin-bottom:4px}
.plan-card .price{font-size:28px;font-weight:800;margin:8px 0 4px}
.plan-card .price span{font-size:14px;color:var(--muted);font-weight:400}
.plan-card .meta{color:var(--muted);font-size:13px}
.canceled-banner{background:#1e1014;border:1px solid var(--red);border-radius:8px;padding:16px;margin-bottom:24px;color:#fca5a5;font-size:14px}
.error-msg{color:var(--red);font-size:14px;margin-top:8px;display:none}
.back-link{display:inline-block;margin-bottom:24px;color:var(--muted);font-size:14px}
.back-link:hover{color:var(--text)}
.spinner{display:none;width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.6s linear infinite;margin:0 auto}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
${NAV_HTML}
<div class="onboard-wrap">
  <a href="/" class="back-link">&larr; Back to 411bz.ai</a>

  ${canceled ? '<div class="canceled-banner">Checkout was canceled. No charges were made. You can try again below.</div>' : ''}

  <div class="step-indicator">
    <div class="step-dot active" id="dot-1"></div>
    <div class="step-dot" id="dot-2"></div>
    <div class="step-dot" id="dot-3"></div>
  </div>

  <!-- STEP 1: Business Info -->
  <div class="step active" id="step-1">
    <h1>Tell us about your business</h1>
    <p class="subtitle">We'll use this to set up your AI authority audit.</p>

    <div class="form-group">
      <label for="domain">Primary Domain</label>
      <input type="text" id="domain" placeholder="example.com" autocomplete="url" required>
    </div>
    <div class="form-group">
      <label for="business_name">Business Name</label>
      <input type="text" id="business_name" placeholder="Acme Corp" autocomplete="organization" required>
    </div>
    <div class="form-group">
      <label for="business_type">Business Type</label>
      <select id="business_type">
        <option value="LocalBusiness">Local Business</option>
        <option value="Restaurant">Restaurant</option>
        <option value="ProfessionalService">Professional Service</option>
        <option value="HealthBusiness">Health &amp; Medical</option>
        <option value="LegalService">Legal Service</option>
        <option value="FinancialService">Financial Service</option>
        <option value="RealEstateAgent">Real Estate</option>
        <option value="AutomotiveBusiness">Automotive</option>
        <option value="HomeAndConstructionBusiness">Home &amp; Construction</option>
        <option value="Store">Retail / E-Commerce</option>
        <option value="SaaS">SaaS / Technology</option>
        <option value="Organization">Organization / Nonprofit</option>
        <option value="Other">Other</option>
      </select>
    </div>
    <div class="error-msg" id="err-1">Please fill in all fields.</div>
    <button class="btn-next" onclick="goStep(2)">Continue</button>
  </div>

  <!-- STEP 2: Plan Selection -->
  <div class="step" id="step-2">
    <h1>Choose your plan</h1>
    <p class="subtitle">All plans include a 7-day free trial. Cancel anytime.</p>

    <div class="plan-grid">
      <div class="plan-card" data-plan="starter" onclick="selectPlan('starter')">
        <h3>Starter</h3>
        <div class="price">$97<span>/mo</span></div>
        <div class="meta">1 domain &middot; 5 runs/day</div>
      </div>
      <div class="plan-card" data-plan="growth" onclick="selectPlan('growth')">
        <h3>Growth</h3>
        <div class="price">$297<span>/mo</span></div>
        <div class="meta">5 domains &middot; 20 runs/day</div>
      </div>
      <div class="plan-card" data-plan="pro" onclick="selectPlan('pro')">
        <h3>Pro</h3>
        <div class="price">$797<span>/mo</span></div>
        <div class="meta">10 domains &middot; 100 runs/day</div>
      </div>
    </div>

    <div class="error-msg" id="err-2">Please select a plan.</div>
    <button class="btn-next" id="btn-step2" onclick="goStep(3)" disabled>Continue with Selected Plan</button>
    <button class="btn-back" onclick="goStep(1)">Back</button>
  </div>

  <!-- STEP 3: Creating account + redirect -->
  <div class="step" id="step-3">
    <h1>Setting up your account...</h1>
    <p class="subtitle">Creating your tenant and redirecting to secure checkout.</p>
    <div class="spinner" id="spinner" style="display:block"></div>
    <div class="error-msg" id="err-3" style="text-align:center"></div>
    <button class="btn-back" onclick="goStep(2)" style="margin-top:24px" id="btn-back-3">Back</button>
  </div>
</div>

<script>
let currentStep = 1;
let selectedPlan = '${preselectedPlan}';

// Pre-select plan if passed via query param
if (selectedPlan) {
  document.querySelectorAll('.plan-card').forEach(c => {
    if (c.dataset.plan === selectedPlan) {
      c.classList.add('selected');
      document.getElementById('btn-step2').disabled = false;
    }
  });
}

function selectPlan(plan) {
  selectedPlan = plan;
  document.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
  document.querySelector('[data-plan="' + plan + '"]').classList.add('selected');
  document.getElementById('btn-step2').disabled = false;
  document.getElementById('err-2').style.display = 'none';
}

function goStep(step) {
  // Validate step 1
  if (step === 2 && currentStep === 1) {
    const domain = document.getElementById('domain').value.trim();
    const name = document.getElementById('business_name').value.trim();
    if (!domain || !name) {
      document.getElementById('err-1').style.display = 'block';
      return;
    }
    document.getElementById('err-1').style.display = 'none';
  }

  // Validate step 2
  if (step === 3 && currentStep === 2) {
    if (!selectedPlan) {
      document.getElementById('err-2').style.display = 'block';
      return;
    }
    // Start the account creation process
    createAccountAndCheckout();
    return;
  }

  // Switch step visibility
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById('step-' + step).classList.add('active');

  // Update step dots
  for (let i = 1; i <= 3; i++) {
    const dot = document.getElementById('dot-' + i);
    dot.classList.remove('active', 'done');
    if (i < step) dot.classList.add('done');
    if (i === step) dot.classList.add('active');
  }

  currentStep = step;
}

async function createAccountAndCheckout() {
  // Show step 3
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById('step-3').classList.add('active');
  for (let i = 1; i <= 3; i++) {
    const dot = document.getElementById('dot-' + i);
    dot.classList.remove('active', 'done');
    if (i < 3) dot.classList.add('done');
    if (i === 3) dot.classList.add('active');
  }
  currentStep = 3;

  const domain = document.getElementById('domain').value.trim();
  const businessName = document.getElementById('business_name').value.trim();
  const businessType = document.getElementById('business_type').value;

  const errEl = document.getElementById('err-3');
  errEl.style.display = 'none';

  try {
    // 1. Create tenant
    const tenantResp = await fetch('/api/v1/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_name: businessName,
        domain: domain,
        business_type: businessType,
        plan: 'trial'
      })
    });
    const tenantData = await tenantResp.json();
    const tenantId = tenantData.data?.tenant_id || tenantData.tenant_id;

    if (!tenantId) {
      throw new Error(tenantData.error || 'Failed to create tenant');
    }

    // 2. Create subscription record (trial)
    await fetch('/api/v1/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        plan: selectedPlan,
        status: 'active',
        current_period_end: new Date(Date.now() + 7 * 86400000).toISOString(),
        stripe_subscription_id: 'pending_checkout_' + Date.now(),
        stripe_customer_id: 'pending_checkout_' + Date.now()
      })
    });

    // 3. Redirect to checkout
    const checkoutResp = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        plan: selectedPlan,
        success_url: window.location.origin + '/billing/' + tenantId + '?session_id={CHECKOUT_SESSION_ID}&welcome=true',
        cancel_url: window.location.origin + '/onboard?canceled=true&plan=' + selectedPlan
      })
    });
    const checkoutData = await checkoutResp.json();
    const checkoutUrl = checkoutData.checkout_url || checkoutData.data?.checkout_url || checkoutData.data?.url;

    if (checkoutUrl) {
      window.location.href = checkoutUrl;
    } else {
      // If checkout isn't configured yet, redirect to billing page
      window.location.href = '/billing/' + tenantId;
    }

  } catch (err) {
    errEl.textContent = 'Error: ' + (err.message || 'Something went wrong. Please try again.');
    errEl.style.display = 'block';
    document.getElementById('spinner').style.display = 'none';
  }
}
</script>
</body>
</html>`;
}


// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD PAGE — Now auth-aware (shows role, logout button)
// ══════════════════════════════════════════════════════════════════════════════

function renderDashboardPage(tenantId: string, authKey: string, auth: TokenPayload | null): string {
  const canStartPipeline = auth?.role === 'owner' || auth?.role === 'admin';
  const canSeeBilling = auth?.role === 'owner' || auth?.role === 'admin';

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard — 411bz.ai</title>
<style>
${SHARED_STYLES}
.dash-wrap{max-width:1100px;margin:0 auto;padding:32px 24px}
.dash-nav{display:flex;gap:4px;margin-bottom:32px;border-bottom:1px solid var(--border);padding-bottom:12px;overflow-x:auto}
.dash-nav a{padding:8px 16px;border-radius:8px 8px 0 0;font-size:14px;font-weight:600;color:var(--muted);white-space:nowrap}
.dash-nav a:hover{color:var(--text)}
.dash-nav a.active{background:var(--surface);color:var(--accent);border:1px solid var(--border);border-bottom:1px solid var(--bg)}
h1{font-size:28px;font-weight:800;margin-bottom:8px}
.subtitle{color:var(--muted);font-size:14px;margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:20px}
.card h2{font-size:18px;font-weight:700;margin-bottom:16px}
.card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:20px}
.metric{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:20px;text-align:center}
.metric .value{font-size:28px;font-weight:800;color:var(--accent)}
.metric .label{font-size:13px;color:var(--muted);margin-top:4px}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;padding:10px 12px;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border);font-size:13px}
td{padding:10px 12px;border-bottom:1px solid var(--border)}
.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600}
.badge-green{background:rgba(34,197,94,0.15);color:var(--green)}
.badge-yellow{background:rgba(245,158,11,0.15);color:var(--yellow)}
.badge-red{background:rgba(239,68,68,0.15);color:var(--red)}
.badge-blue{background:rgba(99,102,241,0.15);color:var(--accent)}
.loading{color:var(--muted);font-size:14px;padding:20px;text-align:center}
.empty{color:var(--muted);font-size:14px;padding:20px;text-align:center;font-style:italic}
.role-badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(99,102,241,0.15);color:var(--accent);margin-left:8px;text-transform:uppercase}
</style></head><body>
${authedNavHtml(auth)}
<div class="dash-wrap">
  <h1>Dashboard ${auth && auth.uid !== 'anonymous' ? `<span class="role-badge">${auth.role}</span>` : ''}</h1>
  <p class="subtitle">Tenant: ${tenantId}</p>

  <div class="dash-nav">
    <a href="#overview" class="active" onclick="showTab('overview',this)">Overview</a>
    <a href="#pipelines" onclick="showTab('pipelines',this)">Pipeline Runs</a>
    <a href="#evidence" onclick="showTab('evidence',this)">Evidence</a>
    <a href="#scorecards" onclick="showTab('scorecards',this)">Scorecards</a>
    ${canSeeBilling ? `<a href="/billing/${tenantId}" style="margin-left:auto;color:var(--accent)">Billing &rarr;</a>` : ''}
  </div>

  <div class="tab-panel" id="panel-overview">
    <div class="card-grid">
      <div class="metric"><div class="value" id="m-plan">—</div><div class="label">Current Plan</div></div>
      <div class="metric"><div class="value" id="m-status">—</div><div class="label">Status</div></div>
      <div class="metric"><div class="value" id="m-runs">—</div><div class="label">Pipeline Runs</div></div>
      <div class="metric"><div class="value" id="m-evidence">—</div><div class="label">Evidence Items</div></div>
    </div>
    ${canStartPipeline ? `<div class="card"><h2>Quick Actions</h2><div style="display:flex;gap:12px;flex-wrap:wrap">
      <button onclick="startPipeline()" style="background:var(--accent);color:#fff;border:none;padding:12px 24px;border-radius:8px;font-weight:600;cursor:pointer">Run New Pipeline</button>
      ${canSeeBilling ? `<a href="/billing/${tenantId}" style="display:inline-block;padding:12px 24px;border:1px solid var(--border);border-radius:8px;font-weight:600;color:var(--text)">Manage Billing</a>` : ''}
    </div></div>` : ''}
  </div>

  <div class="tab-panel" id="panel-pipelines" style="display:none"><div class="card"><h2>Recent Pipeline Runs</h2><div id="pipelines-content" class="loading">Loading...</div></div></div>
  <div class="tab-panel" id="panel-evidence" style="display:none"><div class="card"><h2>Evidence Collection</h2><div id="evidence-content" class="loading">Loading...</div></div></div>
  <div class="tab-panel" id="panel-scorecards" style="display:none"><div class="card"><h2>Authority Scorecards</h2><div id="scorecards-content" class="loading">Loading...</div></div></div>
</div>
<script>
const TENANT='${tenantId}',KEY='${authKey}',headers={'X-Authority-Key':KEY,'Content-Type':'application/json'};
function showTab(n,el){document.querySelectorAll('.tab-panel').forEach(p=>p.style.display='none');document.querySelectorAll('.dash-nav a').forEach(a=>a.classList.remove('active'));document.getElementById('panel-'+n).style.display='block';if(el)el.classList.add('active')}
function statusBadge(s){const m={active:'green',completed:'green',running:'blue',pending:'yellow',failed:'red',canceled:'red'};return'<span class="badge badge-'+(m[s]||'blue')+'">'+s+'</span>'}
async function loadOverview(){try{const r=await fetch('/api/subscription/'+TENANT,{headers});if(r.ok){const d=await r.json(),s=d.data||d;document.getElementById('m-plan').textContent=(s.plan||'trial').toUpperCase();document.getElementById('m-status').innerHTML=statusBadge(s.status||'none')}}catch{}}
async function loadPipelines(){const el=document.getElementById('pipelines-content');try{const r=await fetch('/api/pipeline?tenant_id='+TENANT,{headers});if(!r.ok){el.innerHTML='<div class="empty">No pipeline data yet.</div>';return}const d=await r.json(),runs=d.data?.runs||d.runs||d.data||[];if(!runs.length){el.innerHTML='<div class="empty">No pipeline runs yet.</div>';return}let h='<div class="table-wrap"><table><thead><tr><th>Run ID</th><th>Status</th><th>Stages</th><th>Started</th></tr></thead><tbody>';runs.slice(0,20).forEach(r=>{h+='<tr><td style="font-family:monospace;font-size:12px">'+(r.run_id||r.id||'—').slice(0,12)+'</td><td>'+statusBadge(r.status||'unknown')+'</td><td>'+(r.current_stage||'—')+'</td><td>'+(r.created_at?new Date(r.created_at).toLocaleDateString():'—')+'</td></tr>'});el.innerHTML=h+'</tbody></table></div>';document.getElementById('m-runs').textContent=runs.length}catch{el.innerHTML='<div class="empty">Could not load pipelines.</div>'}}
async function loadEvidence(){const el=document.getElementById('evidence-content');try{const r=await fetch('/api/v1/evidence/'+TENANT,{headers});if(!r.ok){el.innerHTML='<div class="empty">No evidence yet.</div>';return}const d=await r.json(),items=d.data?.items||d.items||d.data||[];if(!items.length){el.innerHTML='<div class="empty">No evidence yet.</div>';return}document.getElementById('m-evidence').textContent=items.length;let h='<div class="table-wrap"><table><thead><tr><th>Type</th><th>Category</th><th>Score</th><th>Collected</th></tr></thead><tbody>';items.slice(0,25).forEach(e=>{h+='<tr><td>'+(e.evidence_type||e.type||'—')+'</td><td>'+(e.category||'—')+'</td><td style="font-weight:700;color:var(--accent)">'+(e.score!=null?e.score:'—')+'</td><td>'+(e.created_at?new Date(e.created_at).toLocaleDateString():'—')+'</td></tr>'});el.innerHTML=h+'</tbody></table></div>'}catch{el.innerHTML='<div class="empty">Could not load evidence.</div>'}}
async function loadScorecards(){const el=document.getElementById('scorecards-content');try{const r=await fetch('/api/v1/scorecards?tenant_id='+TENANT,{headers});if(!r.ok){el.innerHTML='<div class="empty">No scorecards yet.</div>';return}const d=await r.json(),cards=d.data?.scorecards||d.scorecards||d.data||[];if(!cards.length){el.innerHTML='<div class="empty">No scorecards yet.</div>';return}let h='<div class="table-wrap"><table><thead><tr><th>Domain</th><th>AII Score</th><th>Grade</th><th>Generated</th></tr></thead><tbody>';cards.slice(0,10).forEach(s=>{const score=s.aii_score||s.score||0;const color=score>=70?'var(--green)':score>=40?'var(--yellow)':'var(--red)';h+='<tr><td>'+(s.domain||'—')+'</td><td style="font-weight:800;font-size:18px;color:'+color+'">'+score+'</td><td>'+(s.authority_grade||s.grade||'—')+'</td><td>'+(s.created_at?new Date(s.created_at).toLocaleDateString():'—')+'</td></tr>'});el.innerHTML=h+'</tbody></table></div>'}catch{el.innerHTML='<div class="empty">Could not load scorecards.</div>'}}
${canStartPipeline ? `async function startPipeline(){try{const r=await fetch('/api/pipeline/start',{method:'POST',headers,body:JSON.stringify({tenant_id:TENANT})});const d=await r.json();if(r.ok){alert('Pipeline started! Run ID: '+(d.data?.run_id||d.run_id||'unknown'));loadPipelines()}else{alert('Error: '+(d.error||d.message||'Could not start pipeline'))}}catch{alert('Error starting pipeline')}}` : ''}
loadOverview();loadPipelines();loadEvidence();loadScorecards();
</script></body></html>`;
}


// ══════════════════════════════════════════════════════════════════════════════
// BILLING PAGE — Now auth-aware
// ══════════════════════════════════════════════════════════════════════════════

function renderBillingPage(
  tenantId: string,
  sub: { status: string; plan: string; current_period_end?: string } | null,
  tenant: { business_name?: string; domain?: string; plan?: string } | null,
  error: string | null,
  auth: TokenPayload | null = null
): string {
  const plan = sub?.plan || tenant?.plan || 'trial';
  const status = sub?.status || 'none';
  const periodEnd = sub?.current_period_end ? new Date(sub.current_period_end).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A';
  const businessName = tenant?.business_name || tenantId;
  const statusColor = status === 'active' ? '#22c55e' : status === 'past_due' ? '#f59e0b' : status === 'canceled' ? '#ef4444' : '#94a3b8';
  const statusLabel = status === 'active' ? 'Active' : status === 'past_due' ? 'Past Due' : status === 'canceled' ? 'Canceled' : 'No Subscription';
  const plans = [
    { id: 'starter', name: 'Starter', price: '$97/mo', domains: 1, pipelines: 5 },
    { id: 'growth', name: 'Growth', price: '$297/mo', domains: 5, pipelines: 20 },
    { id: 'pro', name: 'Pro', price: '$797/mo', domains: 10, pipelines: 100 },
  ];

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Billing — ${businessName} — 411bz.ai</title>
<style>
${SHARED_STYLES}
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
.welcome-banner{background:rgba(34,197,94,0.08);border:1px solid var(--green);border-radius:8px;padding:16px;margin-bottom:24px;color:#86efac;font-size:14px}
.back-link{display:inline-block;margin-bottom:24px;color:var(--muted);font-size:14px}
</style></head><body>
${authedNavHtml(auth)}
<div class="container">
  <a href="/dashboard/${tenantId}" class="back-link">&larr; Back to Dashboard</a>
  <h1>Billing &amp; Subscription</h1>
  <p class="subtitle">${businessName}</p>
  ${error ? `<div class="error-banner">${error}</div>` : ''}
  <div id="welcome-banner" style="display:none" class="welcome-banner">Welcome to 411bz.ai! Your account is set up and ready to go.</div>
  <div class="status-card">
    <div class="status-row"><span class="status-label">Tenant ID</span><span class="status-value" style="font-family:monospace;font-size:12px">${tenantId}</span></div>
    <div class="status-row"><span class="status-label">Current Plan</span><span class="status-value" style="text-transform:capitalize">${plan}</span></div>
    <div class="status-row"><span class="status-label">Status</span><span class="badge" style="background:${statusColor}">${statusLabel}</span></div>
    <div class="status-row"><span class="status-label">Period Ends</span><span class="status-value">${periodEnd}</span></div>
  </div>
  <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">Change Plan</h2>
  <p style="color:var(--muted);font-size:14px;margin-bottom:16px">Select a plan to upgrade or change your subscription.</p>
  <div class="plans-grid">
    ${plans.map(p => `<div class="plan-option ${p.id === plan ? 'current' : ''}"><h3>${p.name}</h3><div class="price">${p.price}</div><div class="meta">${p.domains} domain${p.domains > 1 ? 's' : ''} &middot; ${p.pipelines} runs/day</div><button ${p.id === plan ? 'disabled' : ''} onclick="checkout('${p.id}')">${p.id === plan ? 'Current Plan' : 'Select'}</button></div>`).join('')}
  </div>
</div>
<script>
if(new URLSearchParams(window.location.search).get('welcome')==='true')document.getElementById('welcome-banner').style.display='block';
async function checkout(plan){try{const r=await fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json','X-Authority-Key':''},body:JSON.stringify({tenant_id:'${tenantId}',plan})});const d=await r.json();if(d.checkout_url||d.data?.checkout_url){window.location.href=d.checkout_url||d.data.checkout_url}else{alert('Error: '+(d.error||'Could not create checkout session'))}}catch{alert('Error connecting to payment system')}}
</script></body></html>`;
}
