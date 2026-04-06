# 411bz.ai — Answer Authority Engineering Platform v2.0

> Permanent systems repair. No temporary fixes. No compliance theater.

## Architecture

```
shared-authority-core/          ← 12 modules: canonical naming, policy, proof gate, content hash
workers/
  411bz-authority-engine/       ← Core: 24 D1 tables, AII computation, connectors
  411bz-orchestrator/           ← 12-stage state machine (CPR/CWAR/AGE)
  authority-content-forge/      ← Multi-surface content generation (7 surfaces, 27 content types)
  authority-solution-compiler/  ← Sole cure compiler with evidence linkage
  authority-examiner/           ← 600-category diagnostic engine (7 surfaces)
  411bz-operator-workbench/     ← Admin SSR UI (10 views: health, tenants, tenant detail,
                                   evidence drill-down, orchestrator runs, run detail,
                                   scorecards, config, audit, affiliates)
  411bz-frontend/               ← User-facing API gateway (runtime-config, no hardcoded hosts)
  411bz-stripe/                 ← Payment webhooks, metering, affiliates
  411bz-observatory/            ← Probe engine, deploy, verify, entity resolution
  411bz-boss-ai/                ← GitHub drift detection
  411bz-schema-engine/          ← Multi-surface schema analysis
  411bz-dashboard/              ← Client-facing dashboard
  411bz-audit/                  ← Cron-based platform audit (every 6h)
scripts/
  ci-guardrails.sh              ← 8 structural enforcement checks
  deploy-all.sh                 ← Dependency-ordered deployment
  migrate-d1.sh                 ← D1 schema migrations
  e2e-test.sh                   ← 12-step E2E acceptance test
```

## Tech Stack

- **Runtime**: Cloudflare Workers (zero Node.js, zero Next.js)
- **Framework**: Hono
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2
- **AI**: Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`)
- **Inter-worker**: Cloudflare Service Bindings (no HTTP URLs)
- **Payments**: Stripe API
- **CI/CD**: GitHub Actions

## Key Design Decisions

1. **shared-authority-core** is the single source of truth for all policy, naming, and validation.
2. **Service bindings** replace all hardcoded `workers.dev` URLs.
3. **Proof gate** prevents any artifact from being stored without valid content hash.
4. **ASC (Authority Solution Compiler)** is the sole cure compiler — enforced structurally.
5. **12-stage orchestrator** with CPR (checkpoint/pause/resume), CWAR (confidence-weighted routing), and AGE (governance engine).
6. **600 categories** in the examiner — not 18, not 50, all 600.
7. **Multi-surface support**: web, video, audio, podcast, webinar, social, ad — across both examiner and forge.
8. **38+ policy keys** centralized in `POLICY_DEFAULTS` — zero magic numbers in worker code.
9. **Truth envelopes** on every response — worker_id, request_id, timestamp, provenance.

## Multi-Surface Content Types

| Surface | Examiner | Content Forge Types |
|---------|----------|---------------------|
| Web | Full 20-dimension scoring | FAQ, schema, E-E-A-T, TOFU/MOFU/BOFU, knowledge base, llms.txt, citation surface, cure action |
| Video | 1.5x density multiplier | Scripts, descriptions, chapters |
| Audio | 1.3x density multiplier | Transcripts, show notes |
| Podcast | 1.4x density multiplier | Outlines, episode notes |
| Webinar | 1.4x density multiplier | Outlines, Q&A prep, follow-up |
| Social | 0.8x density multiplier | Posts, threads, carousels |
| Ad | 0.6x density multiplier | Copy, headlines, descriptions |

## Developer Guide

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v3+
- Cloudflare account with Workers, D1, R2, and Workers AI enabled
- Stripe account for payment processing

### Local Development

```bash
# Clone and install
git clone https://github.com/Robert-411bz-com/answer-authority-engineering.git
cd answer-authority-engineering
npm install

# Copy environment template
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your actual keys

# Run a specific worker locally
cd workers/411bz-authority-engine
npx wrangler dev
```

### CI Guardrails

Run before every commit:

```bash
npm run guardrails
# or directly:
bash scripts/ci-guardrails.sh
```

All 8 checks must pass:

1. No `callForgeLLM` or `callForge` function names
2. No hardcoded `localhost` or `127.0.0.1`
3. No `TODO` or `FIXME` in production code
4. No `placeholder` or `stub` in production code
5. All workers have `wrangler.toml`
6. No duplicate worker names
7. Every worker exports a default app
8. Shared core has barrel export

### Deployment

```bash
# Create D1 databases first
wrangler d1 create 411bz-authority-db
wrangler d1 create 411bz-orchestrator-db
wrangler d1 create 411bz-forge-db
wrangler d1 create 411bz-observatory-db
wrangler d1 create 411bz-schema-engine-db

# Update database_id values in each wrangler.toml

# Run migrations
npm run migrate

# Set secrets for each worker
wrangler secret put AUTHORITY_INTERNAL_KEY --name 411bz-authority-engine
wrangler secret put STRIPE_SECRET_KEY --name 411bz-stripe
# ... etc

# Deploy all workers in dependency order
npm run deploy
```

### E2E Testing

```bash
# Set BASE_URL to your deployed frontend
export BASE_URL=https://your-frontend.workers.dev
bash scripts/e2e-test.sh
# Target: 12/12 checks passing
```

### Adding a New Worker

1. Create directory under `workers/`
2. Add `wrangler.toml`, `package.json`, `tsconfig.json`
3. Import from `shared-authority-core` for all policy, naming, validation
4. Use `wrapTruth()` for all responses
5. Use `assertTenantId()` for all tenant-scoped routes
6. Add to `CANONICAL_WORKERS` in shared core
7. Add to `scripts/deploy-all.sh`
8. Run `npm run guardrails` — all 8 must pass

## Governance

See [GOVERNANCE.md](./GOVERNANCE.md) for architecture rules and CI/CD policies.

See [PLATFORM_STATUS.md](./PLATFORM_STATUS.md) for current deployment status.
