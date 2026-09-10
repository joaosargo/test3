# Scalability Requirements — `unit-sla-escalation`

Scalability NFRs for the **SLA Reminder and Escalation** unit. Scale is driven
by the size of the pending-request backlog (requests awaiting a team lead or HR
decision) and the scan cadence — not by interactive user traffic, since this
unit is a **timer-driven background scanner** ([[business-logic-model]] Design
Approach). Bounds come from the at-most-once idempotency and bounded-tier
invariants in [[business-rules]] (`BR-SLA-4`, `BR-SLA-6`, `BR-SLA-7`), and the
concurrency / retention NFRs in [[requirements]] (`req-nfr-concurrency`,
`req-nfr-audit-retention`, `req-sla-reminder-escalation`).

Like the workflow it observes, growth is a function of headcount and seasonal
approval peaks, not viral or machine-generated load. The scaling strategy is
deliberately conservative: **a single scanner instance with idempotent,
bounded-per-tick work** suffices at the projected scale, with a clear (and
already-safe) path to horizontal fan-out if volume ever demands it.

## Load Projections

| Dimension | Baseline assumption (confirm at nfr-design) | Growth horizon |
|-----------|---------------------------------------------|----------------|
| Employees (potential submitters) | up to a few thousand | 2×–3× over 3 years |
| Pending requests at any tick (`Submitted` + `Validated`) | tens to low hundreds | scales with headcount + seasonal peaks |
| Tiers evaluated per request | ≤ 2 per stage (`Reminder`, `Escalation`) | fixed by policy ([[business-rules]] `BR-SLA-4`) |
| Notices dispatched per tick (steady state) | near-zero (only newly-crossed thresholds) | bounded by threshold-arrival rate, not backlog |
| Ledger records per request | ≤ 4 (2 stages × 2 tiers) | fixed by state machine + policy |

The dominant scaling insight: **dispatch volume does not grow with the pending
backlog**. Because each tier fires at most once per `(requestId, stage, tier)`
([[business-rules]] `BR-SLA-6`), a steady-state tick over a large pending set
dispatches only for the few requests that *just* crossed a threshold; the rest
are cheap `OnTrack`/already-fired evaluations. Work per tick is `O(pending
requests)` for evaluation but `O(newly-due tiers)` for the expensive dispatch
path.

## Scaling Strategy

- **Single stateless scanner, scale by cadence first.** At the projected scale a
  single scanner instance running `runScanTick` on a cadence (placeholder 15 min,
  per [[performance-requirements]]) handles the entire pending set well within
  budget. The scanner holds no state between ticks — all durable state is the
  append-only ledger behind `ReminderLedgerRepository` and the read-only workflow
  view ([[domain-entities]]) — so it can be restarted or relocated freely.
- **Horizontal fan-out is idempotency-safe when needed.** If the pending set ever
  outgrows a single-instance tick budget, the scan can be partitioned (e.g. by
  `department` or `RequestId` range, reusing the workflow's existing
  `findByDepartmentAndStatus` scoped read, [[business-logic-model]] Pending-request
  read). Crucially, **no coordination is required for correctness**: the ledger's
  `(requestId, stage, tier)` dedupe key ([[business-rules]] `BR-SLA-6`) makes
  overlapping or double-covering scanners safe — at worst two scanners evaluate
  the same request, but only one ledger append wins per tier. This is the same
  at-least-once + idempotent posture the notification unit uses.
- **Reuse of the notification transport scales downstream independently.**
  Dispatch goes through the `unit-notifications` `EmailSenderPort` /
  `InAppInboxPort` seam ([[business-rules]] `BR-SLA-12`), so notice-send capacity,
  batching, and retry/dead-letter scaling are owned by the notification unit — the
  SLA unit does not re-implement or separately scale transport.
- **Read load on the workflow is bounded and offloadable.** The tick performs one
  `listPending()` batch read per cadence, not per request. It reads a **narrowed
  view**, never the mutating aggregate, so it adds negligible, non-contending load
  to `unit-request-workflow`; if that read ever needs isolation it can be served
  from a read replica / status projection without changing the SLA scan logic.

## Data Growth & Retention

- **Append-only ledger growth is linear and bounded per request.** The ledger
  gains at most one `ReminderRecord` per fired `(requestId, stage, tier)` — at
  most 4 per request ([[domain-entities]] `ReminderRecord`; [[business-rules]]
  `BR-SLA-7`). Total ledger size grows linearly with request count, not with time
  or scan frequency (an already-fired tier is never re-appended, `BR-SLA-6`), so
  capacity planning is straightforward: `records ≈ requests × up-to-4`.
- **Retention is operational, not compliance.** The reminder ledger is an
  **operational** decision trail, explicitly distinct from the compliance
  `audit-trail` owned by `unit-audit-trail` ([[business-logic-model]] Own durable
  state). It is **not** bound by the 7-year `req-nfr-audit-retention` window that
  governs the audit trail; the SLA ledger may be retained on a shorter,
  operationally-driven horizon (confirm at nfr-design / infrastructure-design).
  Compliance-grade evidence of state changes lives in the audit trail, not here.
- **No unbounded backlog replay.** After downtime, catch-up fires each un-fired
  tier once (`BR-SLA-6a`); it does not replay history, so recovery data volume is
  bounded by the current pending backlog, not by elapsed downtime.

## Scaling Triggers & Limits

- **Cadence-tightening trigger.** If reminders must fire closer to their
  threshold, shorten the cadence before adding instances — a single instance
  absorbs a much tighter cadence at this scale (evaluation is sub-millisecond per
  request, [[performance-requirements]]).
- **Fan-out trigger.** Add partitioned scanner instances only when a single
  `runScanTick` approaches its wall-clock budget at the tightened cadence; the
  ledger dedupe guarantees this is safe without distributed locking.
- **Ledger-store limit.** The durable append-only ledger's write throughput and
  single-key `hasFired` read latency are the primary store-side limits; both stay
  low because appends occur only on threshold crossings and reads are single-key
  by the composite idempotency key.
- **No premature distribution.** At the projected volume a single scanner and a
  single logical ledger partition suffice for MVP; partitioning is available but
  not required (`req-nfr-concurrency` — confirm the concrete figure at nfr-design).

## Open Items (for NFR-design)

- Confirm the scan **cadence** and whether horizontal partitioning is warranted
  at the concrete `req-nfr-concurrency` figure from [[requirements]].
- Confirm the reminder-ledger **retention horizon** (operational, shorter than
  the audit trail's 7-year window) with infrastructure-design.
- Confirm the production ledger store technology and its single-key read / append
  characteristics jointly with infrastructure-design.
