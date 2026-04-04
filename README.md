# 411bz.ai — Answer Authority Engineering Platform v2.0

> Permanent systems repair. No temporary fixes. No compliance theater.

## Architecture

```
shared-authority-core/          ← 12 modules: canonical naming, policy, proof gate, content hash
workers/
  411bz-authority-engine/       ← Core: 24 D1 tables, AII computation, connectors
  411bz-orchestrator/           ← 12-stage state machine (CPR/CWAR/AGE)
  authority-content-forge/      ← Content generation via Cloudflare Workers AI
  authority-solution-compiler/  ← Sole cure compiler with evidence linkage
  authority-examiner/           ← 600-category diagnostic engine
  411bz-operator-workbench/     ← Admin SSR UI (5 views)
  411bz-frontend/               ← User-facing API gateway (no hardcoded hosts)
  411bz-stripe/                 ← Payment webhooks, metering, affiliates
  411bz-observatory/            ← Domain probe engine
  411bz-boss-ai/                ← GitHub drift detection
  411bz-schema-engine/          ← Schema.org JSON-LD generation
  411bz-dashboard/              ← Client-facing dashboard
  411bz-audit/                  ← Cron-based platform audit (every 6h)
scripts/
  ci-guardrails.sh              ← 8 structural enforcement checks
  deploy-all.sh                 ← Dependency-ordered deployment
  migrate-d1.sh                 ← D1 schema migrations
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono (no Node.js, no Next.js)
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2
- **AI**: Cloudflare Workers AI
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

## Quick Start

```bash
# Install dependencies
npm install

# Run guardrails
npm run guardrails

# Deploy all workers
npm run deploy

# Run D1 migrations
npm run migrate
```

## Governance

See [GOVERNANCE.md](./GOVERNANCE.md) for architecture rules and CI/CD policies.
