# Memory — infrastructure-design / unit-status-query

## Interpretations
- 2026-09-10T14:15:00Z — Ran in full mode (no explicit QUESTION-ONLY/ARTIFACT-ONLY signal from the orchestrator); the NFR designs (performance/scalability/reliability/security) had already resolved this unit's open items to a clear infra handoff, so no blocking ambiguity remained and I proceeded straight to design + artifacts without a separate question round.
- 2026-09-10T14:15:00Z — Treated the on-disk `aidlc-docs/construction/{unit}/infrastructure-design/` markdown files as the artifact-of-record mechanism (mirroring the completed `unit-request-workflow` outputs), since the `create_artifact` MCP tool is not wired in this environment and all prior stages recorded to disk here.
- 2026-09-10T14:15:00Z — Produced `shared-infrastructure.md` (conditional): this unit shares/consumes resources across four other units (workflow table read-only, platform compute/ALB/observability, auth+authz in-process), which satisfies the "multiple units share infrastructure" trigger.

## Deviations
- 2026-09-10T14:15:00Z — This unit stands up ZERO standalone provisioned resources at MVP (only a read-only IAM grant + router mount + metric wiring), so the deployment/services artifacts describe *consumed* and *shared* infra rather than owned infra — a departure from the resource-heavy shape of a command-path unit, driven by the `logical-components` "owns no infrastructure of its own" handoff.

## Tradeoffs
- 2026-09-10T14:15:00Z — Recommended BUILDING the `(department, status)` GSI at MVP rather than deferring: the scoped-queue read (`listScopedRequests`) is the only scan-risk access pattern, and a GSI is cheap on DynamoDB and removes that risk; deferral would trade a small cost saving for a latent hot-read scan. Flagged as confirm-against-`req-nfr-concurrency`, so it stays reversible.
- 2026-09-10T14:15:00Z — Kept no read cache at MVP (honouring PERF-D-4) rather than provisioning a Redis-class cache proactively; the correctness risk against the strongly-consistent append-only store outweighs the latency benefit at projected volume. Cache-aside shape is documented as the port-isolated future option.

## Open questions
- 2026-09-10T14:15:00Z — Replace the 99.9% availability SLO placeholder (REL-D-1) and the read-concurrency/throughput figures with the concrete `req-nfr-availability-tbd` / `req-nfr-concurrency` values, then re-derive SCALE-D-9 thresholds and confirm the GSI build-vs-defer decision.
- 2026-09-10T14:15:00Z — Confirm with `unit-request-workflow` (table owner) the exact GSI key schema/capacity and whether read replicas / on-demand vs provisioned read capacity are warranted at the confirmed volume (SCALE-D-8).
- 2026-09-10T14:15:00Z — Confirm the store-read timeout (~800 ms, REL-D-3) and retry budget (≤2, REL-D-4) against the production store's measured latency distribution.
