---
consumes: [performance-requirements, security-requirements, scalability-requirements, reliability-requirements, tech-stack-decisions, business-logic-model]
unit: unit-audit-trail
stage: nfr-design
---

# Performance Design — `unit-audit-trail`

Concrete performance design for the **Immutable Audit Trail** unit — the
append-only event sink and read-only query surface for every accepted state
transition in the vacation-request workflow. This design turns the targets in
`performance-requirements` (PERF-AUD-1…9) into implementable mechanisms, honours
the async choreography posture from `business-logic-model`, the small
PII-free record shape from `security-requirements` (SEC-AUD-11), the 7-year
monotonic-growth reality from `scalability-requirements` (SCAL-AUD-6/7), the
completeness-over-latency SLO from `reliability-requirements` (REL-AUD-1), and
the adopt-the-shipped-stack decisions in `tech-stack-decisions` (SHA-256 via
Node `crypto`, in-process Express, hexagonal `AuditStore` port).

The one fact that dominates every decision below: per `business-logic-model`
this unit is a **choreography side-effect consumer** — `recordEvent` runs off
the synchronous command path (PERF-AUD-1). The performance goal is therefore
**sustained bounded-cost ingest** and **bounded read latency for the compliance
auditor**, never sub-100ms user-perceived latency.

## Performance Budgets

Restated from `performance-requirements` as the design contract these mechanisms
must hold. All figures are server-side handling (handler-in → response/append
issued), excluding client network, render, and store I/O where noted.

| Path | Target (p95) | Target (p99) | Mechanism (this doc) |
|------|--------------|--------------|----------------------|
| `recordEvent` per-event ingest handling | ≤ 20 ms | ≤ 50 ms | O(1) amortised work; per-record hash only |
| Ingest sustained throughput | ≥ 50 events/s + 2× headroom | — | stateless horizontal consumers, per-`requestId` parallelism |
| `getRequestTrail(requestId)` | ≤ 100 ms | ≤ 200 ms | single-partition ordered read (bounded record count) |
| `queryTrail(filter)` | ≤ 500 ms | ≤ 1 s | secondary-index-backed filtered read (see below) |
| `verifyChain(requestId)` | ≤ 300 ms | ≤ 600 ms | single-partition O(n) walk, on-demand/scheduled only |

The ingest rate tracks workflow write volume 1:1 (≤ ~4 events per request,
bounded by the workflow state machine — `performance-requirements` PERF-AUD-4);
bursts are absorbed by the transport buffer, never by back-pressuring the
workflow command path.

## Ingest Optimisation (off the command path)

- **PD-AUD-1 — Fire-and-forget subscription, never awaited.** The composition
  root subscribes `recordEvent` to the shipped `EventPublisher` port as an async
  side-effect handler; `unit-request-workflow` publishes and returns without
  awaiting audit (PERF-AUD-1, REL-AUD-3). On the AWS target this is the shared
  EventBridge bus with this unit owning its own subscription rule + queue, so a
  slow sink can never inflate the command latency budget.
- **PD-AUD-2 — O(1) amortised per-event work.** Each `recordEvent` performs at
  most one dedup lookup by `(eventType, requestId, occurredAtMs)`
  (`AuditStore.findByKey`), one `chainHead(requestId)` read, one SHA-256 over a
  single record's canonical bytes, and one `append` — no N-record scan, no
  cross-partition read (PERF-AUD-2). Steady-state ingest cost is independent of
  chain length and of total corpus size.
- **PD-AUD-3 — Per-record hashing, never per-chain.** `AuditRecord.fromEvent`
  hashes only the record being appended, using the stored `chainHead` as
  `prevHash` (PERF-AUD-3). Full-chain hashing is confined to on-demand
  `verifyChain` (PD-AUD-8). This is what keeps ingest cost flat as a request's
  sub-chain and the 7-year corpus grow.
- **PD-AUD-4 — Idempotent short-circuit saves CPU and storage.** A redelivered
  event (at-least-once choreography) hits the dedup check first and returns the
  existing record with no hash and no append (PERF-AUD-8, REL-AUD-4). The dedup
  key must be an indexed exact-match lookup in every adapter (in-memory: a `Map`
  keyed by the composite; durable: the store's primary/secondary key), so the
  duplicate path is a single point read, not a scan.
- **PD-AUD-5 — Canonical serializer is a pure hot-path function.** Per
  `tech-stack-decisions`, hashing uses a small hand-rolled version-tagged
  canonical serializer (stable key order, fixed number formatting) rather than
  `JSON.stringify`. It allocates one buffer per record over a bounded,
  PII-free field set (`security-requirements` SEC-AUD-11), so serialization +
  SHA-256 cost is small and constant per record. No reflection, no schema
  lookup on the hot path.

## Read & Verification Optimisation

- **PD-AUD-6 — Single-partition reads stay cheap by construction.**
  `getRequestTrail` and `verifyChain` read exactly one `requestId` partition
  whose record count is bounded by the workflow state machine (≤ ~4 transitions)
  — so their latency does not grow with total trail size (PERF-AUD-5). No
  index or cache is needed to hold their budgets; the partition key read is
  sufficient.
- **PD-AUD-7 — `queryTrail` is the only corpus-scaling read; back it with a
  secondary index.** `queryTrail(filter)` is the sole path that scans the
  growing 7-year corpus (`scalability-requirements` SCAL-AUD-4). To hold ≤ 500 ms
  p95 as the corpus grows, the durable adapter MUST serve `TrailQuery`'s
  selective fields via secondary indexes rather than a full-corpus scan:
  a `department`-partitioned, `occurredAtMs`-sorted index for the common
  "department over a date range" auditor query, with `eventType`/`actorId` as
  filter predicates. Concrete index shape is finalised jointly with
  infrastructure-design (this resolves `performance-requirements` and
  `scalability-requirements` Open Items). Unbounded result sets are paginated
  (cursor over `occurredAtMs` + `auditId`) so a wide filter cannot blow the
  latency budget or memory.
- **PD-AUD-8 — Integrity verification is on-demand/scheduled, never on the read
  path.** `verifyChain` is O(n) in one partition and is invoked explicitly by
  the auditor or on a schedule (PERF-AUD-6, REL-AUD-8); routine
  `getRequestTrail` reads never trigger a chain walk. This keeps ordinary trail
  reads inside the table above while integrity sweeps run as a separate,
  latency-tolerant workload.
- **PD-AUD-9 — No caching layer on the read surface (deliberate).** Reads are
  low-frequency compliance activity (single-digit concurrency —
  `scalability-requirements` SCAL-AUD-4) and must reflect the durable trail
  exactly (evidence integrity, `security-requirements` SEC-AUD-8). A read cache
  would add staleness risk and invalidation complexity for no throughput benefit
  at this access rate; the store's own read capacity is sufficient. This is a
  conscious departure from the generic "cache read-heavy APIs" pattern because
  this surface is neither read-heavy nor staleness-tolerant.

## Resource & Efficiency Design

- **PD-AUD-10 — Append-only, single-write-per-event.** Each accepted event
  yields exactly one immutable append (PERF-AUD-7, `security-requirements`
  SEC-AUD-5); there is no update/delete and no read-modify-write, so write
  amplification is minimal and predictable — the durable store is provisioned
  for a steady append rate, not for random-write contention.
- **PD-AUD-11 — Compact, bounded-size records.** Records carry only pseudonymous
  ids and non-PII scalars plus two hashes (PERF-AUD-9, SEC-AUD-11), so per-record
  serialize/hash cost and storage footprint are small and constant — the linear
  capacity projection in `scalability-requirements` SCAL-AUD-7 holds.
- **PD-AUD-12 — Connection/resource pooling for the durable adapter.** The
  production `AuditStore` adapter reuses a pooled client/connection to the durable
  store (pool sized to ingest concurrency × handling time × 1.5 buffer) rather
  than per-event connections, keeping the PD-AUD-1 async ingest cheap under
  seasonal bursts. The in-memory dev/test adapter needs none.

## Measurement & Benchmarks

- Instrument `recordEvent` with an ingest-duration histogram tagged by
  `eventType` and outcome (`ok` / `duplicate` / `malformed`) and a
  records-appended counter, so PD-AUD-2/PD-AUD-4 and PERF-AUD-2/4 are tracked
  (emit on the shared CloudWatch/X-Ray plane the monolith already runs).
- Instrument query handlers with a duration histogram tagged by operation
  (`getRequestTrail` / `queryTrail` / `verifyChain`) and result size, to guard
  the read budgets and detect `queryTrail` index regressions as the corpus grows.
- The existing `vitest` suite is the correctness gate; a lightweight ingest smoke
  (drive N duplicate deliveries of one event, assert exactly one stored record
  and constant per-event latency) validates PD-AUD-2/PD-AUD-4 without a full load
  rig — mirroring the benchmark note in `performance-requirements`.

## Resolved / Deferred Items

- **Resolved:** ingest sustained target set at ≥ 50 events/s with 2× headroom,
  parallelised per `requestId` (PD-AUD-2, SCAL-AUD-2) — confirm against the
  quantified `req-nfr-concurrency` at infrastructure-design.
- **Resolved (design intent):** `queryTrail` is backed by a
  `department`+`occurredAtMs` secondary index with pagination (PD-AUD-7); the
  concrete index technology is an infrastructure-design decision.
- **Deferred to infrastructure-design:** aged-data tiering must not change read
  correctness for retained records (`scalability-requirements` SCAL-AUD-8); a
  colder tier may raise `queryTrail` latency for old ranges but must still meet
  the auditor's tolerance and remain hash-verifiable.
