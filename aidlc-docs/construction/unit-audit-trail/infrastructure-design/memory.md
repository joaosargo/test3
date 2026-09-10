# Infrastructure Design — memory (unit-audit-trail)

Running diary for the infrastructure-design stage of `unit-audit-trail`. Entries
are dated ISO 8601.

## Interpretations
- 2026-09-10T14:17:00Z — treated the audit unit as an embedded in-process module of the shared monolith (same posture as unit-request-workflow), so it adds no compute of its own; grounded in logical-components (C1–C8) and the workflow unit's shared-infrastructure ownership boundaries.
- 2026-09-10T14:17:00Z — selected the durable append-only store as a DynamoDB table (per-`requestId` partition, `TX#` sort) with S3 Object Lock (WORM, COMPLIANCE mode) as the retained-evidence tier; DynamoDB alone does not enforce storage-layer immutability against an operator, so S3 Object Lock is the SD-AUD-9 teeth. This is the biggest infra interpretation and is flagged as an open item for the procurement gate.

## Deviations
- 2026-09-10T14:17:00Z — deliberately provisioned NO read cache on the audit read surface, departing from the generic "cache read-heavy APIs" pipeline default, because performance-design PD-AUD-9 forbids it (evidence must reflect the durable trail exactly).

## Tradeoffs
- 2026-09-10T14:17:00Z — chose DynamoDB + S3-Object-Lock-WORM over QLDB. QLDB gives a built-in cryptographic journal but is being deprecated by AWS and would fragment the shipped DynamoDB seam; the app already computes its own SHA-256 hash chain, so the ledger value is redundant. Recorded as an open item under the procurement gate.
- 2026-09-10T14:17:00Z — SQS FIFO vs standard for the ingest queue: chose standard SQS with idempotent dedup (the app already dedups on `(eventType,requestId,occurredAtMs)`), avoiding FIFO throughput caps; ordering is reconstructed from `occurredAtMs` + chain, not from queue order (RD-AUD-7).

## Open questions
- 2026-09-10T14:17:00Z — confirm concrete durable WORM store + retention class under `req-constraint-build-gate`; DynamoDB+S3-Object-Lock is the design intent, not a procured decision.
- 2026-09-10T14:17:00Z — confirm concrete RPO/RTO and backup cadence jointly with the unit-request-workflow store owner (shared retention posture).
- 2026-09-10T14:17:00Z — confirm whether the KMS signing seam (SD-AUD-10) is activated at MVP or deferred.
- 2026-09-10T14:17:00Z — confirm the `req-nfr-concurrency` figure so ingest auto-scaling thresholds can be set concretely.
