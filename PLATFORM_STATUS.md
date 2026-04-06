# 411bz.ai Platform Status

> Last updated: 2026-04-05

## Architecture Overview

| Component | Worker Name | Status | Description |
|-----------|-------------|--------|-------------|
| Authority Engine | `411bz-authority-engine` | Built | Core: 24 D1 tables, 53+ routes, AII computation |
| Orchestrator | `411bz-orchestrator` | Built | 12-stage state machine with CPR/CWAR/AGE |
| Content Forge | `authority-content-forge` | Built | Multi-surface content generation (7 surfaces) |
| Solution Compiler | `authority-solution-compiler` | Built | Sole cure compiler with evidence linkage |
| Examiner | `authority-examiner` | Built | 600-category diagnostic engine (7 surfaces) |
| Operator Workbench | `411bz-operator-workbench` | Built | 10 SSR views, no React/Next.js |
| Frontend | `411bz-frontend` | Built | User-facing API proxy, runtime-config |
| Stripe | `411bz-stripe` | Built | Payment webhooks and metering |
| Observatory | `411bz-observatory` | Built | Probe engine, deploy, verify, entity resolution |
| Boss AI | `411bz-boss-ai` | Built | GitHub drift detection |
| Schema Engine | `411bz-schema-engine` | Built | Multi-surface schema analysis |
| Dashboard | `411bz-dashboard` | Built | God dashboard API |
| Audit | `411bz-audit` | Built | Cron-based audit worker |

## Shared Core

| Module | Purpose |
|--------|---------|
| `canonicalize.ts` | Canonical worker names — single source of truth |
| `content-hash.ts` | SHA-256 content hashing for artifact integrity |
| `policy-defaults.ts` | 38+ policy keys — all thresholds centralized |
| `tenant-policy.ts` | TenantPolicy.resolve() — per-tenant override resolution |
| `artifact-schema.ts` | ContentArtifact type and ArtifactKind enum |
| `proof-gate.ts` | Proof gate enforcement — no artifact without hash |
| `truth-envelope.ts` | wrapTruth() — every response wrapped with provenance |
| `evidence-ledger.ts` | Evidence chain types and validation |
| `assertions.ts` | assertTenantId() — runtime safety |
| `deployment-policy.ts` | Deployment readiness evaluation |
| `asc-contracts.ts` | Authority Solution Compiler cure validation |
| `score-provenance.ts` | AII computation with full provenance chain |

## Multi-Surface Support

All 7 surfaces are supported across Examiner and Content Forge:

| Surface | Examiner | Content Forge | Content Types |
|---------|----------|---------------|---------------|
| Web | Scoring + diagnostics | FAQ, schema, E-E-A-T, TOFU/MOFU/BOFU, knowledge base | Standard web content |
| Video | Surface-aware scoring (1.5x multiplier) | Scripts, descriptions, chapters | YouTube, Vimeo, Wistia |
| Audio | Surface-aware scoring (1.3x multiplier) | Transcripts, show notes | MP3, WAV, OGG |
| Podcast | Surface-aware scoring (1.4x multiplier) | Outlines, episode notes | Spotify, Apple Podcasts |
| Webinar | Surface-aware scoring (1.4x multiplier) | Outlines, Q&A prep, follow-up | Zoom, Teams |
| Social | Surface-aware scoring (0.8x multiplier) | Posts, threads, carousels | LinkedIn, X, Facebook |
| Ad | Surface-aware scoring (0.6x multiplier) | Copy, headlines, descriptions | PPC, display ads |

## CI Guardrails (8 Checks)

1. No `callForgeLLM` or `callForge` function names (LLM masquerade)
2. No hardcoded `localhost` or `127.0.0.1` in production code
3. No `TODO` or `FIXME` in production code
4. No `placeholder` or `stub` in production code
5. All workers have `wrangler.toml`
6. No duplicate worker names across wrangler configs
7. Every worker exports a default app
8. Shared core has barrel export (`index.ts`)

## Deployment Prerequisites

Before deploying to Cloudflare:

1. **Create D1 databases** via `wrangler d1 create <name>` for each worker with a DB binding
2. **Run D1 migrations** via `scripts/migrate-d1.sh`
3. **Set secrets** via `wrangler secret put <KEY>` for each worker
4. **Deploy workers** via `scripts/deploy-all.sh`

## Known Limitations

- GitHub Actions workflow files require a PAT with `workflow` scope to push
- D1 database IDs in wrangler.toml are placeholders until databases are created
- GoHighLevel integration is designed but not yet wired (requires GHL API credentials)
- Hetzner integration planned but not yet implemented
