<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is maintained by the orchestrator during stage execution. Add observations at the gate ritual, not by editing here directly.

## Interpretations
- 2026-09-10T13:49:20Z — treated the unit's dominant NFR as durability+completeness of evidence over raw uptime; set trail completeness (100% of accepted transitions eventually recorded) as the primary reliability SLO and gave the read surface a lower 99.5% availability target than the workflow command path's 99.9%, because audit reads are low-frequency compliance activity, not a real-time user path.
- 2026-09-10T13:49:20Z — because audit is a choreography side-effect consumer (never on the command path), framed ingest performance as off-critical-path async throughput (p95 ≤ 20ms per-event handling, ≥ 50 events/s) rather than user-perceived latency; only queryTrail scans the growing corpus and was flagged as the primary read-scaling concern.
- 2026-09-10T13:49:20Z — treated the 7-year retention (req-nfr-audit-retention) as the distinctive scalability driver: the corpus grows monotonically/unbounded with time, unlike the workflow aggregate's bounded per-request footprint. Capacity planning must assume strictly increasing store size across the retention window.

## Deviations
- 2026-09-10T13:49:20Z — the runtime does not expose the methodology MCP tools (create_artifact / get_artifact / send_output / collect_metric) in this agent's tool set. Followed the on-disk convention every prior unit used (files under aidlc-docs/construction/<unit>/nfr-requirements/) so the artifacts are visible to the deterministic sensors and consistent with unit-request-workflow's already-shipped NFR docs. No approval question rendered (human gate is out-of-band).
- 2026-09-10T13:49:20Z — issued no ask_question; unit scope, the WorkflowEvent contract, append-only/hash-chain integrity, PII posture, and the fixed 7-year retention were all unambiguous from the functional-design artifacts and requirements. The two functional-design open questions (WORM/legal-hold storage class; auditor department scope) are correctly deferred to infrastructure-design/authz, and I carried them forward as Open Items rather than inventing answers.

## Tradeoffs
- 2026-09-10T13:49:20Z — kept the MVP integrity mechanism at hash-chain tamper-evidence and deferred KMS-backed cryptographic signing (non-repudiation) to nfr-design/infrastructure-design, behind the AuditStore seam. Rationale: hash chain detects tampering in-process with zero external dependency; signing needs managed keys. Reversible per "reversibility over perfection".
- 2026-09-10T13:49:20Z — required storage-layer append-only enforcement (WORM/object-lock) in production (SEC-AUD-9) rather than relying solely on the type-level no-mutation port, so immutability holds even against an operator with store credentials. Concrete storage class deferred to infrastructure-design under the procurement gate (req-constraint-build-gate).

## Open questions
- 2026-09-10T13:49:20Z — confirm the durable append-only / WORM store's durability class, backup cadence, and concrete RPO/RTO jointly with infrastructure-design and the unit-request-workflow store owner (shared retention posture).
- 2026-09-10T13:49:20Z — confirm the queryTrail secondary-index strategy (department / eventType / date range) needed to hold read latency as the 7-year corpus grows.
- 2026-09-10T13:49:20Z — confirm the dead-letter/alerting path for malformed events and the cadence for automated verifyChain integrity sweeps.
