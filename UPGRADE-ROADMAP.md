# Open-Auther Upgrade Roadmap

This is the living upgrade plan for Open-Auther. Items are marked complete only
after the implementation is present and the relevant verification passes.

## Current baseline

The project already provides a local OpenAI-compatible gateway with:

- [x] OpenAI Chat Completions, Anthropic Messages, and Codex Responses surfaces.
- [x] OAuth, API-key, custom endpoint, Antigravity, and Kimi Web connections.
- [x] Credential rotation, cooldowns, failover, token refresh, and model affinity.
- [x] Model discovery, capability metadata, virtual models, and model sync.
- [x] Image input, tools, streaming, request logs, health diagnostics, and a dashboard.
- [x] SQLite persistence with migrations and secret redaction.
- [x] Provider metadata registry and authentication adapter registry.
- [x] Unit and live verification suites.

## Phase 1 — Stabilization and developer workflow

- [ ] Normalize all historical `ai-auther` / `open-auther` names and paths.
- [x] Add a strict TypeScript typecheck command.
- [x] Run the live verification suite in CI and before publishing.
- [x] Add request IDs and consistent response correlation headers.
- [x] Add request body, image, and attachment limits at the HTTP boundary.
- [x] Improve health diagnostics with dependency and runtime details.
- [x] Add a documented Node 22/24 test matrix.

## Phase 2 — Gateway security

- [ ] Hash gateway keys at rest and support one-time key display.
- [x] Add key scopes, expiration, revocation, and per-key model policies.
- [x] Add per-key and per-IP rate limiting.
- [x] Add configurable per-key daily request/token budgets and maximum output limits.
- [ ] Add encrypted credential backup and restore.
- [ ] Add optional OS-keychain or envelope encryption for OAuth tokens.
- [ ] Add secure custom-endpoint/SSRF policy controls.
- [ ] Document and test reverse-proxy/TLS deployments.

## Phase 3 — Provider extensibility

- [x] Extend the provider plugin contract with transport, auth, refresh,
      discovery, health, and error-classification adapters.
- [ ] Move provider-specific transport selection out of the central client.
- [ ] Add a complete external-provider example.
- [x] Add a provider adapter contract test suite.
- [x] Keep registration explicit and validate plugin capabilities.

## Phase 4 — Routing intelligence

- [ ] Add configurable routing policies for capability, health, latency, quota,
      provider priority, and cost.
- [ ] Add per-provider/model circuit breakers.
- [ ] Add retry budgets and idempotency-aware retry rules.
- [ ] Add cost and quota metadata to model records.
- [ ] Add conversation-level sticky routing policies.
- [ ] Explain routing and fallback decisions in logs and the dashboard.

## Phase 5 — Storage and deployment

- [x] Introduce a public storage interface around SQLite.
- [ ] Add encrypted backup/restore and migration checks.
- [ ] Add a shared-storage implementation suitable for PostgreSQL.
- [ ] Add distributed credential-refresh locks for multi-instance deployments.
- [ ] Add shared dashboard event delivery for multiple gateway instances.
- [ ] Add production Docker and reverse-proxy deployment documentation.

## Phase 6 — API and dashboard

- [x] Add API-key scope and expiration controls to the dashboard.
- [x] Add a live model explorer with provider and capability filters.
- [x] Add connection model-health details and troubleshooting actions.
- [ ] Improve Responses API fidelity, structured output, and prompt caching.
- [ ] Add supported embeddings, audio, files, and batch endpoints where a
      provider adapter can implement them correctly.
- [ ] Add OpenTelemetry and Prometheus-compatible metrics.
- [ ] Add request traces, cost charts, quota timelines, and model comparisons.
- [ ] Add dashboard routing-policy, backup, and key-policy editors.
- [ ] Improve mobile and accessibility support.

## Phase 7 — Compression and model operations

- [ ] Add provider-specific token counting to Caveman.
- [ ] Make compression context-window and budget aware.
- [ ] Add summary caching and compression quality measurements.
- [ ] Add model evaluation/probing workflows and historical capability changes.
- [ ] Add automated retired-model migration suggestions.

## Verification gate

Every completed item must be followed by the smallest relevant verification. A
release must pass:

```bash
npm run typecheck
npm run build
npm run test
npm run verify
npm run pack:check
```

The roadmap is intentionally checked into the repository so future changes can
update it alongside the implementation.
