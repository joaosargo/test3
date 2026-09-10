---
consumes: [business-logic-model, business-rules, requirements]
unit: unit-audit-trail
stage: nfr-requirements
---

# Scalability Requirements — `unit-audit-trail`

Scalability NFRs for the **Immutable Audit Trail** unit. Scale here is dominated
by one distinctive fact: the trail is **write-once, never-deleted, and retained
for seven years** (`requirements` `req-nfr-audit-retention`), so its data volume
grows **monotonically and unboundedly with time**, unlike the workflow
aggregate whose per-request footprint is bounded. Targets derive from the
append-only event-sink design in the unit's `business-logic-model`, the
chain-partition and retention rules in its `business-rules` (`BR-AUD-4`,
`BR-AUD-7`, `BR-AUD-7a`), and the retention/concurrency NFRs in `requirements`
(`req-nfr-audit-retention`, `req-immutable-audit-trail`).

The unit is an internal, choreography-driven sink: ingest scales with workflow
write volume (a function of headcount and seasonal peaks), and the read side
scales with auditor activity, which is low-frequency. The scaling strategy
favours stateless horizontal ingest plus a durable, partition-friendly
append-only store, avoiding premature distributed complexity.

## Load Projections

| Dimension | Baseline assumption (confirm at nfr-design) | Growth horizon |
|-----------|---------------------------------------------|----------------|
| Events ingested / request | ≤ ~4 (one per accepted transition) | fixed by the workflow state machine |
| Events / day (peak) | tracks workflow write volume — low thousands at seasonal peak | scales with headcount (2×–3× / 3y) |
| Peak ingest rate | ≥ 50 events/s with 2× headroom (placeholder) | per resolved `req-nfr-concurrency` |
| Concurrent auditor reads | single digits (low-frequency compliance activity) | flat |
| **Total stored records** | **cumulative, 7-year window, never purged early** | **linear in cumulative request count × ~4** |

The per-request event count is **bounded by the workflow state machine**
(`business-logic-model`): a request produces a small fixed number of transition
events, so ingest *rate* tracks workflow activity and does not grow per request.
What grows without bound is the **cumulative corpus**, because of retention.

## Scaling Strategy

- **SCAL-AUD-1 — Stateless horizontal ingest.** The `recordEvent` handler holds
  no per-event state between calls; all state lives in the `AuditStore` behind
  its port (`business-logic-model` Persistence). Ingest consumers scale out
  horizontally with no affinity, the same posture the shipped units use.
- **SCAL-AUD-2 — Per-`requestId` chain partitioning avoids a global bottleneck.**
  The hash chain is partitioned by `requestId` (`business-rules` `BR-AUD-4`), so
  the only serialization point is the chain head *within a single request's
  sub-chain* — and a single request sees at most one concurrent transition at a
  time (one lead, then one HR approver). There is **no global chain head** to
  serialize on, so ingest parallelises cleanly across distinct requests and the
  store shards cleanly on `requestId`.
- **SCAL-AUD-3 — Idempotent ingest makes scale-out safe.** Because ingestion is
  idempotent on `(eventType, requestId, occurredAtMs)` (`business-rules`
  `BR-AUD-2`), at-least-once delivery across multiple ingest instances yields
  exactly one stored record; horizontal scaling does not risk duplicate rows.
- **SCAL-AUD-4 — Read/query side scales independently.** Auditor reads
  (`getRequestTrail`, `queryTrail`, `verifyChain`) are decoupled from ingest and
  low-frequency; they scale with the durable store's read capacity, independent
  of ingest throughput. Single-partition reads (`getRequestTrail`,
  `verifyChain`) stay cheap regardless of corpus size; only `queryTrail` scans
  the growing corpus and is the primary read-scaling concern (needs indexing —
  see Open Items).
- **SCAL-AUD-5 — Durable append-only store behind the port.** The in-memory
  adapter is dev/test only; production wires a durable append-only / WORM store
  keyed by `requestId` (`business-logic-model` Persistence). Because writes are
  append-only and reads are predominantly single-key, the store scales with
  standard partitioning and does not require cross-partition transactions.

## Data Growth & Retention

- **SCAL-AUD-6 — Seven-year monotonic growth (`req-nfr-audit-retention`).** Every
  record carries `retainUntilMs = recordedAtMs + SEVEN_YEARS_MS` (`business-rules`
  `BR-AUD-7`) and MUST NOT be purged before it (`BR-AUD-7a`). The corpus therefore
  grows for at least seven years before any record becomes purge-eligible;
  capacity planning must assume a strictly increasing store size over that window.
- **SCAL-AUD-7 — Capacity projection.** Storage ≈ (requests/year × ~4 events ×
  per-record size) × 7 years + index/chain overhead. Per-record size is small and
  constant (pseudonymous ids + scalars + two hashes — `business-rules` `BR-AUD-8`),
  so the projection is linear and predictable for infrastructure-design.
- **SCAL-AUD-8 — Cold/aged data tiering.** Because reads skew heavily toward
  recent requests while old records must remain retained-and-verifiable, aged
  records are candidates for a cheaper storage tier (still append-only / WORM,
  still hash-verifiable). Tiering strategy is an infrastructure-design decision;
  this unit's obligation is only that tiering never mutates or drops a record
  before `retainUntilMs`.
- **SCAL-AUD-9 — Purge is out-of-band and post-retention only.** Any
  retention-expiry purge is a separate lifecycle job operating on `retainUntilMs`
  (`business-rules` `BR-AUD-7a`), never a runtime capability of this unit — so
  scaling the ingest/read tiers never introduces a deletion path.

## Scaling Triggers & Limits

- **SCAL-AUD-10 — Ingest scale-out trigger.** Add ingest-consumer instances when
  sustained event-lag (bus backlog) or per-instance ingest rate approaches the
  sizing threshold; concrete autoscaling thresholds are set at nfr-design against
  the resolved `req-nfr-concurrency` figure.
- **SCAL-AUD-11 — Store-side limit.** The durable store's write IOPS and the
  `queryTrail` scan cost over the growing corpus are the primary limits;
  per-`requestId` partitioning (SCAL-AUD-2) keeps per-partition contention near
  one writer.
- **SCAL-AUD-12 — No premature sharding.** At projected volume a single logical
  partition suffices; `requestId` sharding is available if growth demands it but
  is not required for MVP.

## Open Items (for nfr-design / infrastructure-design)

- Confirm the concrete ingest-rate and headcount growth figures against the
  resolved `req-nfr-concurrency`.
- Decide the `queryTrail` secondary-index strategy (department / eventType / date
  range) needed to keep query latency bounded as the 7-year corpus grows.
- Decide the durable append-only / WORM store technology and the aged-data
  tiering posture jointly with infrastructure-design and the `unit-request-workflow`
  store owner.
