/**
 * 411bz-stripe — Payment webhooks, metering, promo codes, affiliate commissions.
 */

import { Hono } from 'hono';
import { POLICY_DEFAULTS, CANONICAL_WORKERS } from 'shared-authority-core';
import { createCheckoutAuthHandoff } from './checkout-auth-handoff';

type Bindings = {
  ENGINE: Fetcher;
  OBSERVATORY: Fetcher;
  ORCHESTRATOR: Fetcher;
  DB: D1Database;
  WORKER_ID: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PUBLISHABLE_KEY: string;
  AUTHORITY_INTERNAL_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

app.post('/webhooks/stripe', async (c) => {
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.json({ error: 'missing_signature' }, 400);

  const body = await c.req.text();
  // Stripe webhook signature verification would go here
  const event = JSON.parse(body) as { type: string; data: { object: Record<string, unknown> } };

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutComplete(c.env, event.data.object);
      break;
    case 'customer.subscription.updated':
      await handleSubscriptionUpdate(c.env, event.data.object);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionCancel(c.env, event.data.object);
      break;
    case 'invoice.paid':
      await handleInvoicePaid(c.env, event.data.object);
      break;
  }

  return c.json({ received: true });
});

app.post('/v1/validate-promo', async (c) => {
  const body = await c.req.json<{ code: string }>();
  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY };
  const resp = await c.env.ENGINE.fetch(new Request('http://internal/v1/promo-codes', { headers }));
  const data = resp.ok ? await resp.json() as { data: Array<{ code: string; days_free: number }> } : { data: [] };
  const promo = (data.data || []).find(p => p.code === body.code.toUpperCase());
  if (!promo) return c.json({ valid: false }, 404);
  return c.json({ valid: true, days_free: promo.days_free });
});

async function handleCheckoutComplete(env: Bindings, session: Record<string, unknown>): Promise<void> {
  // Process new subscription, apply promo codes, set up affiliate tracking
  const tenantId = (session.metadata as Record<string, string>)?.tenant_id || (session.client_reference_id as string) || '';

  // --- Auth handoff: create auth code keyed by Stripe session ID ---
  // This lets the frontend exchange ?session_id={CHECKOUT_SESSION_ID} for an auth cookie.
  // Non-fatal: if this fails the user can still log in via magic link.
  if (tenantId) {
    await createCheckoutAuthHandoff(env, session as any, tenantId);
  }
}

async function handleSubscriptionUpdate(env: Bindings, sub: Record<string, unknown>): Promise<void> {
  // Update tenant plan status
}

async function handleSubscriptionCancel(env: Bindings, sub: Record<string, unknown>): Promise<void> {
  // Handle cancellation
}

async function handleInvoicePaid(env: Bindings, invoice: Record<string, unknown>): Promise<void> {
  // Process affiliate commissions based on POLICY_DEFAULTS rates
  const amount = (invoice.amount_paid as number) || 0;
  // Commission calculation uses centralized rates from POLICY_DEFAULTS
  const _independentCommission = amount * POLICY_DEFAULTS.AFFILIATE_COMMISSION_INDEPENDENT;
  const _agencyCommission = amount * POLICY_DEFAULTS.AFFILIATE_COMMISSION_AGENCY;
  const _affiliateAgencyCommission = amount * POLICY_DEFAULTS.AFFILIATE_COMMISSION_AFFILIATE_AGENCY;
}

export default app;
