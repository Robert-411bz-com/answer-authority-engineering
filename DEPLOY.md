# 411bz Auth Release — Deployment Guide

**One path. No branches. No "if this repo" vs "if that repo."**

This directory (`411bz-auth-release/`) contains the canonical, deploy-ready files.
Copy them into your clone of `answer-authority-engineering`, commit, push, deploy.

---

## Canonical Names (memorize these)

| Thing | Name | NOT this |
|-------|------|----------|
| Auth module | `auth.ts` | ~~tenant-auth.ts~~ |
| D1 binding | `DB` | ~~OBSERVATORY_DB~~ |
| Import path | `from './auth'` | ~~from './tenant-auth'~~ |
| Runtime version | `4.0.0` | ~~2.2.0~~ |
| Cookie name | `__411bz_token` | (no alternatives) |
| D1 database | `observatory-production` | ~~411bz-frontend-production~~ |

---

## Files in This Release

```
411bz-auth-release/
├── DEPLOY.md                              ← You are here
├── workers/
│   ├── 411bz-frontend/
│   │   ├── wrangler.toml                  ← Drop-in replacement
│   │   └── src/
│   │       ├── auth.ts                    ← NEW: HMAC tokens + cookies
│   │       └── index.ts                   ← REPLACE: Full Phase 4 frontend
│   └── 411bz-stripe/
│       ├── wrangler.toml                  ← Drop-in replacement (adds DB binding)
│       └── src/
│           └── checkout-auth-handoff.ts   ← MERGE: Add to handleCheckoutComplete
```

---

## Step 1: Copy Files Into Your Clone

```bash
cd /path/to/answer-authority-engineering

# Frontend — new auth module
cp 411bz-auth-release/workers/411bz-frontend/src/auth.ts \
   workers/411bz-frontend/src/auth.ts

# Frontend — replace index.ts (this is the full Phase 4 worker)
cp 411bz-auth-release/workers/411bz-frontend/src/index.ts \
   workers/411bz-frontend/src/index.ts

# Frontend — replace wrangler.toml
cp 411bz-auth-release/workers/411bz-frontend/wrangler.toml \
   workers/411bz-frontend/wrangler.toml

# Stripe — replace wrangler.toml (adds DB binding)
cp 411bz-auth-release/workers/411bz-stripe/wrangler.toml \
   workers/411bz-stripe/wrangler.toml

# Stripe — merge auth handoff into handleCheckoutComplete
# See checkout-auth-handoff.ts for the code to add.
# At the end of handleCheckoutComplete, add:
#   import { createCheckoutAuthHandoff } from './checkout-auth-handoff';
#   await createCheckoutAuthHandoff(env, session, tenantId);
```

### Stripe Merge (Detailed)

Open `workers/411bz-stripe/src/index.ts`. Find `handleCheckoutComplete`. At the end of that function, before the closing brace, add:

```typescript
// Auth handoff — create owner user + auth code for checkout redirect
await createCheckoutAuthHandoff(env, session, resolvedTenantId || tenantId);
```

And at the top of the file, add the import:
```typescript
import { createCheckoutAuthHandoff } from './checkout-auth-handoff';
```

If your stripe worker uses `engineFetch` (the deployed monolith pattern), `tenantId` comes from `metadata.tenant_id`. If it uses D1 direct (the CleanSlate pattern), `resolvedTenantId` comes from the slug lookup. Use whichever variable holds the final tenant ID.

---

## Step 2: Delete Stale Files

If any of these exist in your clone, delete them — they are superseded:

```bash
rm -f workers/411bz-frontend/src/tenant-auth.ts    # Wrong name
rm -f workers/411bz-frontend/src/layout.ts          # Old v1 multi-file
rm -f workers/411bz-frontend/src/types.ts           # Old v1 multi-file
rm -rf workers/411bz-frontend/src/pages/            # Old v1 multi-file
rm -rf workers/411bz-frontend/src/api/              # Old v1 multi-file
rm -rf workers/411bz-frontend/src/lib/              # Old v1 multi-file
```

---

## Step 3: Verify Before Deploy

```bash
# Auth module exists and uses correct name
ls workers/411bz-frontend/src/auth.ts
# → must exist

# No stale naming
ls workers/411bz-frontend/src/tenant-auth.ts 2>/dev/null && echo "ERROR: delete tenant-auth.ts" || echo "OK"

# Import is correct
grep "from './auth'" workers/411bz-frontend/src/index.ts
# → must match

# D1 binding is DB, not OBSERVATORY_DB
grep 'binding = "DB"' workers/411bz-frontend/wrangler.toml
grep 'binding = "DB"' workers/411bz-stripe/wrangler.toml
# → both must match

# No OBSERVATORY_DB anywhere
grep -r 'OBSERVATORY_DB' workers/ && echo "ERROR: stale OBSERVATORY_DB reference" || echo "OK"

# No tenant-auth references
grep -r 'tenant-auth' workers/ && echo "ERROR: stale tenant-auth reference" || echo "OK"

# Version is 4.0.0
grep "version.*4.0.0" workers/411bz-frontend/src/index.ts
# → must match

# Stripe has auth handoff
grep 'createCheckoutAuthHandoff\|auth_codes' workers/411bz-stripe/src/*.ts
# → must show matches
```

If any check fails, fix it before deploying.

---

## Step 4: Deploy

```bash
# Stripe first (creates auth_codes on checkout completion)
cd workers/411bz-stripe && npx wrangler deploy && cd ../..

# Frontend second (reads auth_codes, serves auth UI)
cd workers/411bz-frontend && npx wrangler deploy && cd ../..
```

---

## Step 5: Verify Deployment

```bash
BASE=https://411bz-frontend.bob-0a9.workers.dev

# Version check — must show 4.0.0
curl -s $BASE/api/runtime-config | grep version

# Health
curl -s $BASE/health
# → {"status":"healthy","worker":"411bz-frontend"}

# Landing page
curl -s $BASE/ | head -3

# Onboarding page (3-step flow)
curl -s $BASE/onboard | head -3

# Login page
curl -s $BASE/login | head -3

# Dashboard without auth — should still be open (no TOKEN_SIGNING_SECRET yet)
curl -sI $BASE/dashboard/test-tenant | head -5
```

---

## Step 6: Activate Auth

```bash
# Generate and save the signing secret
SECRET=$(openssl rand -hex 48)
echo "TOKEN_SIGNING_SECRET=$SECRET" >> ~/.411bz-secrets  # or your password manager

# Set it on the frontend worker
printf '%s' "$SECRET" | npx wrangler secret put TOKEN_SIGNING_SECRET --name 411bz-frontend
```

---

## Step 7: Verify Auth Is Active

```bash
BASE=https://411bz-frontend.bob-0a9.workers.dev

# Dashboard should now redirect to login
curl -sI $BASE/dashboard/test-tenant | grep Location
# → Location: /login?redirect=/dashboard/test-tenant

# Login page renders
curl -s $BASE/login | grep "Sign in"

# API routes still work with X-Authority-Key (E2E unaffected)
curl -s -H "X-Authority-Key: YOUR_KEY" $BASE/api/v1/tenants | head -3
```

---

## Step 8: Commit and Push

```bash
git add workers/411bz-frontend/ workers/411bz-stripe/
git commit -m "feat: tenant-scoped auth (HMAC cookies, checkout handoff, magic links)

- auth.ts: HMAC-SHA256 token signing/verify, HttpOnly cookies
- requireTenantAuth middleware on /dashboard and /billing
- Stripe checkout creates auth_codes for session_id exchange
- Login page + magic link flow (email sending is console.log until Resend configured)
- D1 binding: DB → observatory-production on both frontend and stripe
- Runtime version: 4.0.0"

git push origin main
```

---

## Rollback

Clear the signing secret to disable auth without redeploying:

```bash
printf '' | npx wrangler secret put TOKEN_SIGNING_SECRET --name 411bz-frontend
```

To fully rollback the code, revert the commit and redeploy.

---

## D1 Schema (Already Applied)

These changes are live in `observatory-production`. No action needed unless starting fresh:

- `auth_codes` table with `stripe_checkout_session_id TEXT` column
- Index `idx_auth_codes_stripe_session` on `auth_codes(stripe_checkout_session_id)`
- Unique index `idx_tenant_users_tenant_email` on `observatory_tenant_users(tenant_id, email)`
- `observatory_tenants.plan_tier` CHECK allows `starter|growth|pro|trial|advanced|enterprise`
- `stripe_checkout_sessions.plan_tier` CHECK allows `starter|growth|pro|trial|advanced|enterprise`

---

## Week 2: Enable Magic Link Emails

```bash
printf 're_YOUR_RESEND_KEY' | npx wrangler secret put EMAIL_API_KEY --name 411bz-frontend
printf '411bz <noreply@411bz.ai>' | npx wrangler secret put EMAIL_FROM --name 411bz-frontend
```

Then update the `POST /api/auth/magic-link` handler to call the Resend API.
Until this is done, magic link URLs are logged to the worker console (visible in `wrangler tail`).
