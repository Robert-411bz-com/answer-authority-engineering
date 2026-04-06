# 411bz.ai Platform Governance

## Architecture Rules

1. **No hardcoded hosts** — All inter-worker communication uses Cloudflare Service Bindings. No `workers.dev` URLs in source code.
2. **Single source of policy** — All thresholds, weights, and limits live in `shared-authority-core/src/policy-defaults.ts`. No inline magic numbers.
3. **Canonical naming** — Worker names are defined in `shared-authority-core/src/canonicalize.ts`. No worker may invent its own name.
4. **Proof gate enforcement** — Every artifact must pass `enforceProofGate()` before persistence. No exceptions.
5. **Content hashing** — Every artifact has a real SHA-256 hash via `computeContentHash()`. No empty strings, no placeholders.
6. **Sole cure compiler** — Only `authority-solution-compiler` creates cure objects. No other worker may create cures.
7. **Evidence linkage** — Every cure must reference at least one `evidence_id`. No cure without evidence.
8. **Truth envelopes** — Every inter-worker response is wrapped in a `TruthEnvelope` with provenance metadata.

## CI/CD Rules

- All 8 guardrail checks must pass before merge.
- Deploy order is enforced: engine first, frontend last.
- D1 migrations run before worker deployment.
- No `.dev.vars` files may be committed.

## Worker Inventory

| Worker | Purpose | Database |
|--------|---------|----------|
| 411bz-authority-engine | Core data, AII computation, 24 tables | authority-production |
| 411bz-orchestrator | 12-stage pipeline, CPR/CWAR/AGE | orchestrator-production |
| authority-content-forge | Content generation via LLM | forge-production |
| authority-solution-compiler | Sole cure compiler | — (uses engine) |
| authority-examiner | 600-category diagnostic engine | — (uses engine) |
| 411bz-operator-workbench | Admin SSR UI (5 views) | — (uses engine) |
| 411bz-frontend | User-facing API gateway | — (uses engine + orchestrator) |
| 411bz-stripe | Payment webhooks, metering | — (uses engine) |
| 411bz-observatory | Domain probe engine | — (uses engine) |
| 411bz-boss-ai | GitHub drift detection | — |
| 411bz-schema-engine | Schema.org generation | — |
| 411bz-dashboard | Client dashboard | — (uses engine) |
| 411bz-audit | Cron-based platform audit | — (uses engine) |
