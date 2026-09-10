---
consumes: [business-logic-model, business-rules, requirements]
unit: unit-audit-trail
stage: nfr-requirements
---

# Reliability Requirements — `unit-audit-trail`

Reliability NFRs for the **Immutable Audit Trail** unit. For a compliance
system-of-record, reliability means one thing above all: **no accepted workflow
transition may ever be silently lost from the trail, and no stored record may
ever be lost or corrupted for its seven-year life.** Availability of the read
surface matters, but *durability and completeness of the evidence* is the
dominant reliability property. Targets derive from the idempotent, fail-closed
ingestion and pure-verification flows in the unit's `business-logic-model`, the
completeness, chain-integrity, and retention rules in its `business-rules`
(`BR-AUD-1`–`BR-AUD-7a`), and the audit/retention NFRs in `requirements`
(`req-immutable-audit-trail`, `req-nfr-audit-retention`,
`req-constraint-append-only-store`).

The unit is a choreography side-effect consumer (`business-logic-model`
Services posture): it reacts to events the workflow command path emits and never
sits on the synchronous command path. A key consequence is that audit
unavailability degrades **compliance visibility**, not the ability to submit or
approve vacation — so its degradation tier differs from the command-path core.

## Availability & Completeness Targets (SLO)

- **REL-AUD-1 — Trail completeness (the primary SLO).** Target **100% of accepted
  workflow transitions eventually recorded** — completeness, not latency, is the
  guarantee. `unit-request-workflow` emits exactly one event per accepted
  transition in the same logical commit (its `BR-INV-5`); this unit's obligation
  is that every delivered event results in exactly one durable record. Measured
  as `recorded_transitions / emitted_transitions` reconciled over a window; the
  target is 1.0 with any gap treated as a compliance incident.
- **REL-AUD-2 — Read-surface availability.** Target **99.5%** monthly
  availability for the auditor read surface (`getRequestTrail`, `queryTrail`,
  `verifyChain`), measured as `successful_or_expected-error_responses /
  total_requests`. This is intentionally lower than the workflow command path's
  99.9%: audit reads are low-frequency compliance activity, not a real-time user
  path. (Placeholder pending any concrete figure in `requirements`
  `req-nfr-availability-tbd`.)
- **REL-AUD-3 — Ingest independence from the command path.** Per the
  `business-logic-model` choreography posture, if this unit is momentarily
  unavailable the workflow command **still commits and returns** — the event is
  buffered/redelivered by the transport and recorded when the sink recovers.
  Audit downtime therefore never reduces workflow availability; it only delays
  (never drops — see REL-AUD-4) the recording of already-committed transitions.

## Consistency, Durability & Fault Tolerance

- **REL-AUD-4 — At-least-once delivery + idempotent ingest = no loss, no
  duplication.** The choreography bus delivers events at least once; this unit's
  idempotent ingest keyed on `(eventType, requestId, occurredAtMs)`
  (`business-rules` `BR-AUD-2`) collapses redeliveries to exactly one stored
  record. A crash between event receipt and append is safe: the bus redelivers
  and the dedup guard prevents a second row on replay. This is the core
  fault-tolerance mechanism against both loss and duplication.
- **REL-AUD-5 — Fail-closed on malformed input.** A malformed or spoofed event
  is rejected with `AuditError.malformedEvent` and **nothing is appended**
  (`business-rules` `BR-AUD-1`); an unrecordable event never silently vanishes
  and never corrupts the chain. Such events are surfaced (dead-lettered /
  alerted) rather than dropped, so a systematic event-shape drift is visible.
- **REL-AUD-6 — Expected failures are values, not exceptions.** Malformed events
  and integrity-verification failures return `Result.err` with a PII-free code
  (`business-logic-model` Error handling); throwing is reserved for
  infrastructure/programmer error, so transient business failures never crash the
  ingest consumer.
- **REL-AUD-7 — Durable append-only persistence.** Production wires a durable
  append-only store behind the `AuditStore` port (`business-logic-model`
  Persistence); the in-memory adapter is dev/test only. A committed record
  survives process restart and instance loss.
- **REL-AUD-8 — Tamper-evident integrity is continuously verifiable.** The
  per-request hash chain (`business-rules` `BR-AUD-6`) plus the pure,
  side-effect-free `verifyChain` (`BR-AUD-9`) let integrity be re-proven on a
  schedule after any restore or migration, detecting silent corruption or
  tampering as an integrity incident rather than a silent data-quality decay.
- **REL-AUD-9 — Ordering is preserved and never rewritten.** Records are appended
  in ingest order and never re-sequenced (`business-rules` `BR-AUD-3`); business
  ordering uses `occurredAtMs`, storage/chain ordering uses append order, so
  out-of-order delivery cannot rewrite history.

## Durability, Backup & Recovery

- **REL-AUD-10 — Seven-year durability (`req-nfr-audit-retention`).** Every record
  carries `retainUntilMs = recordedAtMs + SEVEN_YEARS_MS` and MUST NOT be purged
  before it (`business-rules` `BR-AUD-7`, `BR-AUD-7a`). The durable store must
  provide durability guarantees (replication, no early expiry) sufficient to
  honour the full seven-year window. Target store durability ≥ 11 nines
  (align with the workflow store's `req-nfr-audit-retention`-driven posture at
  infrastructure-design).
- **REL-AUD-11 — Backup / point-in-time recovery.** The durable store must
  support backup and point-in-time recovery consistent with seven-year retention.
  Because the trail is append-only (`business-rules` `BR-AUD-5`), recovery
  restores a consistent ordered timeline with no in-place-edit reconciliation,
  and `verifyChain` re-proves integrity post-restore (REL-AUD-8).
- **REL-AUD-12 — Recovery objectives.** Placeholder RPO ≈ 0 for committed records
  (append-only + at-least-once redelivery means an in-flight event is redelivered,
  not lost) and RTO of the read surface ≤ a few hours (compliance reads tolerate
  a recovery window). Concrete RPO/RTO confirmed jointly with infrastructure-design.

## Graceful Degradation

Mapping this unit and its dependency to a degradation tier (per the NFR-design
degradation model):

| Concern | Tier | Degradation behaviour |
|--------|------|-----------------------|
| Event ingest (from `unit-request-workflow`) | Important (not Critical to command path) | Sink down → events buffered/redelivered by the transport; workflow commits regardless (REL-AUD-3); recorded on recovery (REL-AUD-4). No transition lost. |
| Durable `AuditStore` (write) | Critical (to the trail's own mission) | Unavailable → ingest retries; no partial/lost append; append-only guarantees no corruption (`BR-AUD-5`). |
| Auditor read surface | Important | Store read slow/unavailable → reads return a retryable error; ingest continues unaffected (read/write decoupled, SCAL-AUD-4). |
| Auth session / authz PDP | Critical (to the read surface) | Cannot authenticate/authorize → `401` / `err(forbidden)`; fail-closed, never serve records without an allow (SEC-AUD-2). |
| Integrity verification (`verifyChain`) | Important | Pure/on-demand (`BR-AUD-9`); a failure is an integrity *alert*, not a service outage — reads still function. |

## Failure-Mode Checklist

- **Sink crashes before append** → event redelivered by the bus; idempotent
  dedup ensures exactly one record on replay (REL-AUD-4). No loss.
- **Duplicate event delivery** → dedup short-circuits; exactly one stored record
  (`business-rules` `BR-AUD-2`).
- **Malformed / out-of-contract event** → rejected, nothing appended, surfaced
  for investigation (REL-AUD-5); chain uncorrupted.
- **Out-of-order delivery** → append order preserved; display ordering uses
  `occurredAtMs`; history not rewritten (REL-AUD-9).
- **Silent storage corruption / tampering** → detected by scheduled `verifyChain`
  (REL-AUD-8) as an integrity incident.
- **Blast radius** → an ingest-consumer instance failure affects only unprocessed
  events on the bus (redelivered elsewhere); it cannot corrupt already-appended
  records (append-only, immutable).

## Open Items (for nfr-design / infrastructure-design)

- Confirm the durable append-only / WORM store's durability class, backup cadence,
  and concrete RPO/RTO jointly with infrastructure-design and the
  `unit-request-workflow` store owner (shared retention posture).
- Confirm the dead-letter / alerting path for malformed events (REL-AUD-5) so a
  systematic event-shape drift is caught, not silently dead-lettered.
- Confirm the schedule/cadence for automated `verifyChain` integrity sweeps.
