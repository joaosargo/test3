---
consumes: [performance-requirements, security-requirements, scalability-requirements, reliability-requirements, tech-stack-decisions, business-logic-model]
unit: unit-audit-trail
stage: nfr-design
---

# Scalability Design — `unit-audit-trail`

Concrete scalability design for the **Immutable Audit Trail** unit. This design
implements the scaling strategy in `scalability-requirements` (SCAL-AUD-1…12),
grounded in the append-only event-sink and per-`requestId` chain-partition model
in `business-logic-model`, aligned with the stateless-horizontal / durable-
append-only-store selections in `tech-stack-decisions`, bounded by the ingest
and read budgets in `performance-requirements` (PERF-AUD-4/5), and constrained
by the WORM-at-rest and completeness guarantees in `security-requirements`
(SEC-AUD-9) and `reliability-requirements` (REL-AUD-1/10).

The distinctive scaling fact drives everything: the trail is **write-once,
never-deleted, retained seven years** (`scalability-requirements` SCAL-AUD-6),
so **data volume grows monotonically and unboundedly with time**. Ingest *rate*
tracks workflow write volume (bounded ≤ ~4 events per request); the **cumulative
corpus** is what grows without bound. The strategy favours stateless horizontal
ingest plus a durable, partition-friendly append-only store, avoiding premature
distributed complexity (SCAL-AUD-12).

## Scaling Architecture

- **SC-AUD-1 — Stateless horizontal ingest (SCAL-AUD-1).** The `recordEvent`
  handler holds no per-event state between calls; all state lives in the
  `AuditStore` behind its port (`business-logic-model` Persistence). Ingest
  consumers scale out horizontally with **no affinity**, the same posture the
  shipped units use. On the AWS target this is the audit unit's own consumer
  behind the shared EventBridge bus — its own subscription rule, its own queue,
  and consumers that add instances without coordination.
- **SC-AUD-2 — Per-`requestId` chain partitioning removes the global bottleneck
  (SCAL-AUD-2).** The hash chain is partitioned by `requestId`, so the only
  serialization point is the chain head **within a single request's sub-chain**
  — and a single request sees at most one concurrent transition at a time (one
  lead, then one HR approver). There is **no global chain head**, so ingest
  parallelises cleanly across distinct requests and the durable store shards
  cleanly on `requestId`.
- **SC-AUD-3 — Idempotent ingest makes scale-out safe (SCAL-AUD-3).** Because
  ingestion is idempotent on `(eventType, requestId, occurredAtMs)`
  (`business-logic-model` BR-AUD-2), at-least-once delivery across multiple
  ingest instances yields exactly one stored record. Horizontal scaling never
  risks duplicate rows — this is also the correctness guarantee behind
  `reliability-requirements` REL-AUD-4.
- **SC-AUD-4 — Read/query side scales independently (SCAL-AUD-4).** Auditor reads
  are decoupled from ingest and low-frequency (single-digit concurrency). They
  scale with the durable store's read capacity, independent of ingest
  throughput. Single-partition reads (`getRequestTrail`, `verifyChain`) stay
  cheap regardless of corpus size (`performance-requirements` PERF-AUD-5); only
  `queryTrail` scans the growing corpus and is the primary read-scaling concern.

## Load Distribution & Partitioning

- **SC-AUD-5 — Ingest load distribution.** The shared bus distributes delivery
  across ingest-consumer instances; because handlers are stateless (SC-AUD-1) and
  idempotent (SC-AUD-3), any instance can process any event and redelivery is
  harmless. No consumer-side sticky routing is required.
- **SC-AUD-6 — Store partition key = `requestId` (SCAL-AUD-2/5).** The durable
  append-only store is keyed by `requestId` for the append + single-partition
  read paths. This gives even distribution (high-cardinality, immutable key),
  query locality (both cheap reads target one partition), and near-one-writer
  per partition (a request's transitions are serial), matching the shard-key
  selection criteria.
- **SC-AUD-7 — `queryTrail` secondary index for the cross-corpus read
  (SCAL-AUD-4, `performance-requirements` PERF-AUD-7).** The one read that scans
  the corpus is served by a secondary index on `department` (partition) +
  `occurredAtMs` (sort), with `eventType`/`actorId` as filter predicates and
  cursor pagination — so `queryTrail` stays bounded (≤ 500 ms p95) as the 7-year
  corpus grows rather than degrading to a full scan. Concrete index technology is
  an infrastructure-design decision (resolves the shared Open Item in
  `scalability-requirements` and `performance-requirements`).
- **SC-AUD-8 — Durable append-only store behind the port (SCAL-AUD-5).** The
  in-memory adapter is dev/test only; production wires a durable append-only /
  WORM store keyed by `requestId`. Because writes are append-only and reads are
  predominantly single-key, the store scales with standard partitioning and
  needs no cross-partition transactions.

## Data Growth & Retention Strategy

- **SC-AUD-9 — Plan for seven-year monotonic growth (SCAL-AUD-6).** Every record
  carries `retainUntilMs = recordedAtMs + SEVEN_YEARS_MS` and MUST NOT be purged
  before it. Capacity planning assumes a strictly increasing store size across
  the full seven-year window; no early-purge relief is modelled.
- **SC-AUD-10 — Linear capacity projection (SCAL-AUD-7).** Storage ≈
  (requests/year × ~4 events × per-record size) × 7 years + index/chain overhead.
  Per-record size is small and constant (pseudonymous ids + scalars + two hashes
  — `security-requirements` SEC-AUD-11), so the projection is linear and
  predictable. Design intent: publish this as a capacity worksheet at
  infrastructure-design against the resolved headcount growth figure (2×–3× / 3y).
- **SC-AUD-11 — Cold/aged data tiering (SCAL-AUD-8).** Reads skew heavily toward
  recent requests while old records must remain retained-and-verifiable. Aged
  records are candidates for a cheaper storage tier that is **still append-only /
  WORM and still hash-verifiable** (`security-requirements` SEC-AUD-9). The
  tiering mechanism (lifecycle transition to colder storage) never mutates or
  drops a record before `retainUntilMs`; a colder tier may raise `queryTrail`
  latency for old date ranges but must still meet the auditor's tolerance.
  Tiering policy is finalised at infrastructure-design.
- **SC-AUD-12 — Purge is out-of-band, post-retention only (SCAL-AUD-9).** Any
  retention-expiry purge is a separate lifecycle job operating on `retainUntilMs`
  — never a runtime capability of this unit. Scaling the ingest/read tiers
  introduces no deletion path, preserving the append-only invariant
  (`security-requirements` SEC-AUD-5).

## Capacity Thresholds & Auto-Scaling Rules

- **SC-AUD-13 — Ingest scale-out trigger (SCAL-AUD-10).** Add ingest-consumer
  instances when **sustained event-lag (bus/queue backlog depth) exceeds a
  target** or per-instance ingest rate approaches the sizing threshold. Design
  intent scale-out signal: consumer backlog age > ~30 s or per-instance rate
  > 70% of the ≥ 50 events/s + 2× headroom envelope; scale-in when backlog is
  drained and rate is low, with a cooldown to avoid flap. Concrete thresholds
  are set against the resolved `req-nfr-concurrency` at infrastructure-design.
- **SC-AUD-14 — Store-side limit (SCAL-AUD-11).** The durable store's write
  throughput and the `queryTrail` scan cost over the growing corpus are the
  primary limits. Per-`requestId` partitioning (SC-AUD-2) keeps per-partition
  write contention near one writer; the secondary index (SC-AUD-7) keeps
  `queryTrail` off a full scan. Monitor write-throttle and index read-latency as
  the leading scaling indicators.
- **SC-AUD-15 — No premature sharding (SCAL-AUD-12).** At projected volume a
  single logical partition space keyed by `requestId` suffices; further sharding
  is available if growth demands it but is not required for MVP. This is the
  design-for-change, avoid-premature-optimisation posture.

## Verification

- Track ingest throughput and consumer backlog age as the scale-out signals
  (SC-AUD-13); assert per-event handling cost stays flat as a request's
  sub-chain and the corpus grow (SC-AUD-2/`performance-requirements` PERF-AUD-3).
- Track `queryTrail` p95 latency against corpus size to catch index regressions
  early (SC-AUD-7); a full-scan fallback should alarm, not silently degrade.
- Publish the linear capacity worksheet (SC-AUD-10) and revisit at each
  headcount-growth milestone across the retention window.
