---
consumes: [performance-requirements, security-requirements, scalability-requirements, reliability-requirements, tech-stack-decisions, business-logic-model]
unit: unit-audit-trail
stage: nfr-design
---

# Reliability Design — `unit-audit-trail`

Concrete reliability design for the **Immutable Audit Trail** unit. This design
implements the SLOs, fault-tolerance mechanisms, and degradation tiers in
`reliability-requirements` (REL-AUD-1…12), grounded in the idempotent,
fail-closed ingestion and pure-verification flows in `business-logic-model`,
aligned with the durable append-only-store / at-least-once-choreography /
`Result<T, AuditError>` selections in `tech-stack-decisions`, and interlocking
with `security-requirements` (integrity is a durability property — SEC-AUD-6/8),
`scalability-requirements` (7-year durability — SCAL-AUD-6), and
`performance-requirements` (ingest is off the command path — PERF-AUD-1).

For a compliance system-of-record, reliability means one thing above all: **no
accepted workflow transition may ever be silently lost from the trail, and no
stored record may ever be lost or corrupted for its seven-year life.**
Availability of the read surface matters, but **durability and completeness of
the evidence** is the dominant property.

## Availability & Completeness SLOs

- **RD-AUD-1 — Trail completeness is the primary SLO (REL-AUD-1).** Target
  **100% of accepted workflow transitions eventually recorded**, measured as
  `recorded_transitions / emitted_transitions` reconciled over a window; target
  = 1.0, any gap treated as a compliance incident. `unit-request-workflow` emits
  exactly one event per accepted transition in the same logical commit (its
  `BR-INV-5`); this unit guarantees every delivered event results in exactly one
  durable record. This is completeness, **not latency** — a recorded-late event
  still counts; a lost event does not.
- **RD-AUD-2 — Read-surface availability = 99.5% monthly (REL-AUD-2).** Measured
  as `successful_or_expected-error_responses / total_requests` for
  `getRequestTrail` / `queryTrail` / `verifyChain`. Intentionally lower than the
  workflow command path's 99.9% because audit reads are low-frequency compliance
  activity, not a real-time user path. (Placeholder pending any concrete figure
  in `req-nfr-availability-tbd`.) Error budget = 0.5%/month ≈ 3.6 h — spent on
  store maintenance windows and cold-tier reads, not on ingest.
- **RD-AUD-3 — Ingest independence from the command path (REL-AUD-3,
  `performance-requirements` PERF-AUD-1).** If this unit is momentarily
  unavailable, the workflow command **still commits and returns**; the event is
  buffered/redelivered by the transport and recorded when the sink recovers.
  Audit downtime never reduces workflow availability — it only delays (never
  drops — RD-AUD-4) the recording of already-committed transitions.

## Resilience Patterns

Applied per failure-mode analysis. The dominant pattern is **at-least-once
delivery + idempotent ingest**, not the synchronous circuit-breaker/retry stack
of a command path — because this unit sits off that path.

| Pattern | Where applied | Configuration (design intent) |
|---------|---------------|-------------------------------|
| **At-least-once + idempotent dedup** | Event ingest | Bus redelivers on non-ack; dedup key `(eventType, requestId, occurredAtMs)` collapses to one record (RD-AUD-4) |
| **Dead-letter queue** | Malformed / repeatedly-failing events | After N delivery attempts (design intent: 5) → DLQ + alert; nothing dropped silently (RD-AUD-5) |
| **Retry with backoff** | `AuditStore.append` transient infra failure | Exponential backoff + jitter, bounded attempts; then re-queue (not drop) so the bus redelivers (RD-AUD-4) |
| **Fail-closed validation** | Inbound event shape | Malformed → `err(malformedEvent)`, nothing appended, DLQ'd (RD-AUD-5) |
| **Timeout + pooled client** | Durable store calls | Bounded per-call timeout; pooled connections (`performance-requirements` PD-AUD-12) |
| **No circuit breaker on ingest (deliberate)** | Ingest → store | Tripping open would risk *dropping* events; instead retry-then-DLQ preserves completeness (RD-AUD-1) |

- **RD-AUD-4 — At-least-once + idempotent = no loss, no duplication (REL-AUD-4).**
  The choreography bus delivers at least once; idempotent ingest keyed on
  `(eventType, requestId, occurredAtMs)` collapses redeliveries to exactly one
  stored record. A crash between receipt and append is safe: the event is not
  acked, the bus redelivers, and the dedup guard prevents a second row on replay.
  This is the core fault-tolerance mechanism against **both** loss and
  duplication and the structural guarantee behind RD-AUD-1.
- **RD-AUD-5 — Fail-closed on malformed input, surfaced not dropped (REL-AUD-5).**
  A malformed/spoofed event is rejected with `AuditError.malformedEvent` and
  **nothing is appended** (`business-logic-model` BR-AUD-1). Such events are
  routed to a **DLQ and alerted** rather than silently discarded, so systematic
  event-shape drift is visible as an operational signal (resolves the malformed-
  event dead-letter Open Item in `reliability-requirements`).
- **RD-AUD-6 — Expected failures are values, not exceptions (REL-AUD-6).**
  Malformed events and integrity-verification failures return `Result.err` with a
  PII-free code (`tech-stack-decisions` `Result<T, AuditError>`); throwing is
  reserved for infrastructure/programmer error, so transient business failures
  never crash the ingest consumer.

## Consistency, Ordering & Integrity

- **RD-AUD-7 — Ordering preserved, never rewritten (REL-AUD-9).** Records are
  appended in ingest order and never re-sequenced (`business-logic-model`
  BR-AUD-3); business ordering uses `occurredAtMs`, storage/chain ordering uses
  append order, so out-of-order delivery cannot rewrite history.
- **RD-AUD-8 — Continuously verifiable integrity (REL-AUD-8,
  `security-requirements` SEC-AUD-8).** The per-request hash chain plus the pure,
  side-effect-free `verifyChain` let integrity be re-proven on a schedule and
  after any restore or migration, detecting silent corruption or tampering as an
  **integrity incident** rather than silent data-quality decay. Design intent
  cadence: a rolling daily sweep of recently-written partitions + a full sweep
  after any restore/migration (resolves the `verifyChain`-cadence Open Item).

## Durability, Backup & Recovery

- **RD-AUD-9 — Durable append-only persistence (REL-AUD-7).** Production wires a
  durable append-only store behind the `AuditStore` port; the in-memory adapter
  is dev/test only. A committed record survives process restart and instance
  loss. Target store durability **≥ 11 nines**, aligned with the workflow
  store's retention posture (REL-AUD-10).
- **RD-AUD-10 — Seven-year durability (REL-AUD-10,
  `scalability-requirements` SCAL-AUD-6).** Every record carries `retainUntilMs`
  and MUST NOT be purged before it; the store provides replication and no early
  expiry sufficient to honour the full window, WORM-protected against edit/delete
  (`security-requirements` SEC-AUD-9).
- **RD-AUD-11 — Backup / point-in-time recovery (REL-AUD-11).** The durable store
  supports backup and PITR consistent with seven-year retention. Because the
  trail is append-only, recovery restores a consistent ordered timeline with no
  in-place-edit reconciliation, and `verifyChain` re-proves integrity
  post-restore (RD-AUD-8).
- **RD-AUD-12 — Recovery objectives (REL-AUD-12).** Design intent **RPO ≈ 0** for
  committed records (append-only + at-least-once redelivery means an in-flight
  event is redelivered, not lost) and **RTO of the read surface ≤ a few hours**
  (compliance reads tolerate a recovery window). Concrete RPO/RTO confirmed
  jointly with infrastructure-design and the `unit-request-workflow` store owner
  (shared retention posture — resolves the durability-class Open Item).

## Graceful Degradation

Degradation tiers per the NFR-design degradation model (`reliability-requirements`
table). The key asymmetry: audit unavailability degrades **compliance
visibility**, not the ability to submit or approve vacation.

| Concern | Tier | Degradation behaviour |
|--------|------|-----------------------|
| Event ingest (from `unit-request-workflow`) | Important (not Critical to command path) | Sink down → events buffered/redelivered by the transport; workflow commits regardless (RD-AUD-3); recorded on recovery (RD-AUD-4). No transition lost. |
| Durable `AuditStore` (write) | Critical (to the trail's own mission) | Unavailable → ingest retries with backoff, event re-queued not acked; no partial/lost append; append-only guarantees no corruption. |
| Auditor read surface | Important | Store read slow/unavailable → reads return a retryable error; ingest continues unaffected (read/write decoupled). |
| Auth session / authz PDP | Critical (to the read surface) | Cannot authenticate/authorize → `401` / `err(forbidden)`; fail-closed, never serve records without an allow (`security-requirements` SEC-AUD-2). |
| Integrity verification (`verifyChain`) | Important | Pure/on-demand; a failure is an integrity **alert**, not a service outage — reads still function. |

## Failure-Mode Checklist

- **Sink crashes before append** → event not acked; bus redelivers; idempotent
  dedup ensures exactly one record on replay (RD-AUD-4). No loss.
- **Duplicate event delivery** → dedup short-circuits; exactly one stored record.
- **Malformed / out-of-contract event** → rejected, nothing appended, DLQ'd and
  alerted (RD-AUD-5); chain uncorrupted.
- **Out-of-order delivery** → append order preserved; display ordering uses
  `occurredAtMs`; history not rewritten (RD-AUD-7).
- **Silent storage corruption / tampering** → detected by scheduled
  `verifyChain` (RD-AUD-8) as an integrity incident.
- **Durable store transient outage** → retry-then-requeue (no circuit-break-to-
  drop), append completes on recovery; RPO ≈ 0 (RD-AUD-12).
- **Blast radius** → an ingest-consumer instance failure affects only unprocessed
  events on the bus (redelivered elsewhere); it cannot corrupt already-appended
  records (append-only, immutable) — contained to in-flight events on that
  instance.
