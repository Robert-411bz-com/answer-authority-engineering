/**
 * checkout-auth-handoff.ts — Auth code creation during Stripe checkout completion.
 *
 * CANONICAL FILE. This code must be merged into handleCheckoutComplete
 * in your stripe worker's index.ts, AFTER the existing engineFetch calls.
 *
 * NAMING: D1 binding is `DB` (not `OBSERVATORY_DB`). Must match wrangler.toml.
 *
 * WHAT THIS DOES:
 *   1. Upserts an observatory_tenant_users row (owner) for the checkout email
 *   2. Inserts an auth_codes row keyed by stripe_checkout_session_id
 *   3. The frontend exchanges session_id for an auth cookie on redirect
 *
 * PREREQUISITES:
 *   - D1 binding `DB` → `observatory-production` in stripe wrangler.toml
 *   - auth_codes table with stripe_checkout_session_id column
 *   - Unique index on observatory_tenant_users(tenant_id, email)
 */

/**
 * Call this at the end of handleCheckoutComplete, after all engineFetch calls.
 *
 * @param env     - Worker environment (must have env.DB: D1Database)
 * @param session - Stripe checkout.session.completed event object
 * @param tenantId - Resolved tenant ID from earlier in the handler
 */
export async function createCheckoutAuthHandoff(
  env: { DB: D1Database },
  session: { id: string; customer_details?: { email?: string }; customer_email?: string; metadata?: Record<string, string> },
  tenantId: string,
): Promise<void> {
  const email =
    session.customer_details?.email ||
    session.customer_email ||
    session.metadata?.email ||
    '';

  if (!email) {
    console.warn('checkout-auth-handoff: no email found, skipping auth code creation');
    return;
  }

  const userId = crypto.randomUUID();
  const authCode = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  try {
    // 1. Upsert owner user — idempotent via unique index (tenant_id, email)
    await env.DB.prepare(
      `INSERT INTO observatory_tenant_users (id, tenant_id, email, role, auth_provider)
       VALUES (?, ?, ?, 'owner', 'password')
       ON CONFLICT (tenant_id, email) DO NOTHING`,
    ).bind(userId, tenantId, email).run();

    // 2. Resolve actual user_id (may be pre-existing)
    const userRow = await env.DB.prepare(
      `SELECT id FROM observatory_tenant_users WHERE tenant_id = ? AND email = ?`,
    ).bind(tenantId, email).first<{ id: string }>();
    const resolvedUserId = userRow?.id || userId;

    // 3. Create auth code keyed by Stripe session ID
    //    Frontend exchanges ?session_id={CHECKOUT_SESSION_ID} for a cookie
    await env.DB.prepare(
      `INSERT INTO auth_codes (code, tenant_id, user_id, purpose, expires_at, stripe_checkout_session_id)
       VALUES (?, ?, ?, 'checkout', ?, ?)`,
    ).bind(authCode, tenantId, resolvedUserId, expiresAt, session.id).run();

    console.log(`checkout-auth-handoff: tenant=${tenantId} user=${resolvedUserId} session=${session.id}`);
  } catch (err) {
    // Non-fatal: user can still log in via magic link.
    // Never let auth handoff failure break the checkout webhook.
    console.error('checkout-auth-handoff error (non-fatal):', err);
  }
}
