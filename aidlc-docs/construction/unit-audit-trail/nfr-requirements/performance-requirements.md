---
consumes: [business-logic-model, business-rules, requirements]
unit: unit-audit-trail
stage: nfr-requirements
---

# Performance Requirements — `unit-audit-trail`

Performance NFRs for the **Immutable Audit Trail** unit — the append-only event
sink and read-only query surface for every accepted state transition in the
vacation-request workflow. Targets derive from the ingestion/query/verification
flows in the unit's `business-logic-model` (`recordEvent`, `getRequestTrail`,
`queryTrail`, `verifyChain`), the idempotency, chain-partition, and PII rules in
its `business-rules` (`BR-AUD-2`, `BR-AUD-4`, `BR-AUD-6`, `BR-AUD-8`), and the
audit/retention/security NFRs enumerated in `requirements`
(`req-immutable-audit-trail`, `req-nfr-audit-retention`, `req-nfr-security-pii`).

Per the `business-logic-model`, this unit is a **choreography side-effect
consumer** — it never sits on the synchronous command path. That single fact
dominates its performance envelope: audit ingestion is *off* the user-facing
critical path (the workflow command commits and emits its event in the same
logical commit, then returns; audit consumes the event asynchronously), so the
performance concern is **sustained ingest throughput and bounded read latency
for the compliance auditor**, not sub-100ms user-perceived latency.

## Ingestion Performance (off the command path)

- **PERF-AUD-1 — Ingest is asynchronous, never on the command path.** Per the
  `business-logic-model` Data Flow, `recordEvent` runs as an event-subscription
  side effect. It MUST NOT be awaited by `unit-request-workflow`; audit slowness
  or backlog must never inflate the workflow command latency budget. This is the
  single most important performance requirement for the unit.
- **PERF-AUD-2 — Per-event ingest work is bounded and O(1) amortised.** Each
  `recordEvent` performs at most: one dedup lookup by key
  `(eventType, requestId, occurredAtMs)` (`business-rules` `BR-AUD-2`), one
  chain-head read for the request partition (`BR-AUD-4`), one SHA-256 over a
  single record's canonical serialization (`BR-AUD-6`), and one append. No
  N-record scan, no cross-partition read. Target server-side ingest handling
  (excluding store I/O): **p95 ≤ 20 ms, p99 ≤ 50 ms** per event.
- **PERF-AUD-3 — Hashing cost is per-record, not per-chain.** `recordEvent`
  hashes only the record being appended (using the stored `chainHead` as
  `prevHash`); it does **not** re-walk the partition. Full-chain hashing is
  confined to on-demand `verifyChain` (PERF-AUD-6). This keeps steady-state
  ingest cost independent of chain length.
- **PERF-AUD-4 — Ingest throughput target.** Since one workflow request produces
  at most a bounded number of events (≤ ~4 transitions per request), audit ingest
  volume tracks workflow write volume 1:1. Baseline sizing (confirm at
  nfr-design): sustain **≥ 50 events/second** with 2× headroom, matching the
  workflow's placeholder `≤ 25 req/s × bounded transitions` envelope. Bursts
  (start-of-quarter) are absorbed by the event transport buffer, not by
  back-pressuring the workflow.

## Query & Verification Latency

Read targets are for **server-side** query handling (request received at the
handler → response written), excluding client network and render. Reads are
non-mutating and side-effect-free (`business-rules` `BR-AUD-9`).

| Operation | Target (p95) | Target (p99) | Rationale |
|-----------|--------------|--------------|-----------|
| `getRequestTrail(requestId)` | ≤ 100 ms | ≤ 200 ms | Single-partition ordered read (`BR-AUD-4`); bounded record count per request. |
| `queryTrail(filter)` | ≤ 500 ms | ≤ 1 s | Filtered scan over the trail; auditor-facing, tolerant of higher latency than a hot user path. |
| `verifyChain(requestId)` | ≤ 300 ms | ≤ 600 ms | Pure walk of one request's sub-chain, recomputing each hash (PERF-AUD-6). |

- **PERF-AUD-5 — Bounded partition reads.** `getRequestTrail` and `verifyChain`
  read a single `requestId` partition whose record count is bounded by the
  workflow state machine (a request reaches terminal state in a small, fixed
  number of transitions), so their cost does not grow with total trail size —
  only `queryTrail` scales with the corpus.
- **PERF-AUD-6 — Integrity verification is on-demand or scheduled, not on the
  read path.** `verifyChain` is O(n) in one partition's records. It is invoked
  explicitly by the auditor or on a schedule (`business-logic-model` Integrity
  Verification Workflow); routine `getRequestTrail` reads do NOT trigger a full
  chain verification, keeping ordinary trail reads within the table above.

## Resource & Efficiency Constraints

- **PERF-AUD-7 — Append-only, single-write-per-event.** Each accepted event
  yields exactly one immutable `AuditRecord` append (`business-rules` `BR-AUD-5`);
  there is no update/delete and no read-modify-write, so write amplification is
  minimal and predictable.
- **PERF-AUD-8 — Idempotent dedup avoids duplicate work AND duplicate storage.**
  A redelivered event (at-least-once choreography) short-circuits at the dedup
  check (`BR-AUD-2`) and returns the existing record, costing one lookup and no
  append — protecting both CPU and storage growth under bus retries.
- **PERF-AUD-9 — PII-free, compact records.** Records carry only pseudonymous
  ids and non-PII scalars (`business-rules` `BR-AUD-8`, `requirements`
  `req-nfr-security-pii`) — no free-text reason, no email — so each record is
  small and of bounded size, keeping serialization/hash cost and storage
  footprint low and constant per record.

## Measurement & Benchmarks

- Instrument `recordEvent` with an ingest-duration histogram tagged by
  `eventType` and outcome (`ok` / `duplicate` / `malformed`), and a
  records-appended counter, so PERF-AUD-2/4 can be tracked.
- Instrument query handlers with a duration histogram tagged by operation
  (`getRequestTrail` / `queryTrail` / `verifyChain`) and result size.
- The existing `vitest` suite is the correctness gate; a lightweight ingest smoke
  (drive N duplicate deliveries of one event, assert exactly one stored record
  and constant latency) validates PERF-AUD-8 without a full load rig.

## Open Items (for nfr-design)

- Confirm the concrete ingest-throughput figure against the workflow's
  quantified `req-nfr-concurrency` once the placeholder is resolved upstream.
- Confirm whether `queryTrail` needs a secondary index (by `department` /
  `eventType` / date range) in the production store to hold the ≤ 500 ms p95
  target as the 7-year corpus grows (`req-nfr-audit-retention`) — jointly with
  infrastructure-design.
