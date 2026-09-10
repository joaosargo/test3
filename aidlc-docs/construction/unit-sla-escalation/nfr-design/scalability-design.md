# Scalability Design — `unit-sla-escalation`

Concrete scaling architecture for the **SLA Reminder and Escalation** unit — the
scaling model, load distribution, partitioning strategy, capacity thresholds,
and scaling triggers that satisfy this unit's `scalability-requirements`. It is
grounded in the timer-driven scanner shape in `business-logic-model` (Design
Approach, Data Flow), the single-instance / idempotent-ledger choices in
`tech-stack-decisions` (Scheduling & Concurrency, Persistence), the at-most-once
and non-blocking invariants in `reliability-requirements`, the tick-budget and
efficiency constraints in `performance-requirements`, and the PII posture in
`security-requirements` (which keeps the scaling unit stateless and its ledger
PII-free).

The governing scaling property, restated from `scalability-requirements`: scale
is driven by **the size of the pending-request backlog and the scan cadence**,
not by interactive user traffic — this unit is a **timer-driven background
scanner**. Growth is a function of headcount and seasonal approval peaks, not
viral or machine-generated load. The strategy is deliberately conservative: **a
single stateless scanner instance with idempotent, bounded-per-tick work**
suffices at the projected scale, with an already-safe path to horizontal
fan-out if volume ever demands it.

## Load Model

Adopted from `scalability-requirements` Load Projections:

| Dimension | Baseline (confirm at infra-design) | Growth horizon |
|-----------|-----------------------------------|----------------|
| Employees (potential submitters) | up to a few thousand | 2×–3× over 3 years |
| Pending requests at any tick (`Submitted` + `Validated`) | tens to low hundreds | scales with headcount + seasonal peaks |
| Tiers evaluated per request | ≤ 2 per stage (`Reminder`, `Escalation`) | fixed by policy (`BR-SLA-4`) |
| Notices dispatched per tick (steady state) | near-zero (only newly-crossed thresholds) | bounded by threshold-arrival rate, not backlog |
| Ledger records per request | ≤ 4 (2 stages × 2 tiers) | fixed by state machine + policy |

**The dominant scaling insight (design cornerstone):** *dispatch volume does not
grow with the pending backlog.* Because each tier fires at most once per
`(requestId, stage, tier)` (`BR-SLA-6`), a steady-state tick over a large
pending set dispatches only for the few requests that *just* crossed a threshold;
the rest are cheap `OnTrack`/already-fired evaluations. Work per tick is
`O(pending)` for evaluation but `O(newly-due tiers)` for the expensive dispatch
path — so the unit scales on the cheap axis, not the expensive one.

## Scaling Architecture — Single Stateless Scanner First

- **One stateless scanner, scale by cadence before instances.** At the projected
  scale a single instance running `runScanTick` on a cadence (placeholder 15 min,
  per `performance-requirements`) handles the entire pending set well within the
  ≤ 30 s tick budget. The scanner **holds no state between ticks** — all durable
  state is the append-only ledger behind `ReminderLedgerRepository` and the
  read-only workflow view (`business-logic-model` Own durable state /
  Pending-request read) — so it can be restarted or relocated freely with no
  warm-up (`reliability-requirements` REL-SLA-10).
- **Statelessness is the scaling enabler.** Because eligibility is re-derived
  freshly each tick from live workflow state and the durable ledger, the compute
  tier carries no session/affinity and no in-memory backlog. This is the same
  stateless posture the shipped units use, and it is what makes both restart and
  fan-out trivial.

## Data Distribution & Partitioning Strategy

Partitioning is **available but not required at MVP**, and — critically —
**needs no coordination for correctness**.

- **Partition dimension: `department` (or `RequestId` range).** If the pending set
  ever outgrows a single-instance tick budget, the scan partitions along the
  workflow's existing `findByDepartmentAndStatus` scoped read
  (`business-logic-model` Pending-request read) — each scanner instance owns a
  slice of departments and issues its own narrowed `listPending()`.
- **No distributed locking, no leader election.** The ledger's
  `(requestId, stage, tier)` dedupe key (`BR-SLA-6`; `tech-stack-decisions`
  Concurrency safety) makes overlapping or double-covering scanners safe: at
  worst two scanners evaluate the same request, but **only one ledger append wins
  per tier**. This is the same at-least-once + idempotent posture
  `unit-notifications` uses, so fan-out inherits a proven correctness argument
  rather than introducing coordination machinery.
- **Downstream transport scales independently.** Dispatch goes through the
  `unit-notifications` `EmailSenderPort` / `InAppInboxPort` seam (`BR-SLA-12`), so
  notice-send capacity, batching, and retry/dead-letter scaling are owned by the
  notification unit — the SLA unit does not re-implement or separately scale
  transport.
- **Bounded, offloadable read load on the workflow.** The tick performs **one**
  `listPending()` batch read per cadence, not per request, against a narrowed
  view (never the mutating aggregate), so it adds negligible, non-contending load
  to `unit-request-workflow`. If that read ever needs isolation it can be served
  from a read replica / status projection without changing the scan logic
  (`scalability-requirements`; `performance-requirements` no-N+1 rule).

## Capacity Planning & Data Growth

- **Append-only ledger growth is linear and bounded per request.** The ledger
  gains at most one `ReminderRecord` per fired `(requestId, stage, tier)` — at
  most 4 per request — so `records ≈ requests × up-to-4`. Growth is linear in
  request count, **not** in time or scan frequency (an already-fired tier is never
  re-appended, `BR-SLA-6`), making capacity planning straightforward
  (`scalability-requirements` Data Growth).
- **Operational, not compliance, retention.** The reminder ledger is an
  operational decision trail, explicitly distinct from the compliance
  `audit-trail` owned by `unit-audit-trail`. It is **not** bound by the 7-year
  `req-nfr-audit-retention` window and may be retained on a shorter,
  operationally-driven horizon (confirm at infrastructure-design). Compliance-grade
  evidence of state changes lives in the audit trail, not here.
- **No unbounded backlog replay.** After downtime, catch-up fires each un-fired
  tier once (`BR-SLA-6a`); it does not replay history, so recovery data volume is
  bounded by the *current* pending backlog, not by elapsed downtime
  (`reliability-requirements` REL-SLA-6).

## Scaling Triggers & Limits

| Trigger / limit | Signal | Response |
|-----------------|--------|----------|
| **Cadence-tightening** | Reminders must fire closer to threshold | Shorten the cadence *before* adding instances — a single instance absorbs a much tighter cadence at this scale (sub-ms evaluation per request, `performance-requirements`). |
| **Fan-out** | A single `runScanTick` approaches its ≤ 30 s wall-clock budget at the tightened cadence | Add partitioned scanner instances by `department`/`RequestId` range; ledger dedupe guarantees safety with no distributed locking. |
| **Ledger-store limit** | `hasFired` single-key read latency or append throughput rising | The durable append-only store's single-key read + append is the primary store-side limit; both stay low because appends occur only on threshold crossings and reads are single-key. Escalate to store tuning / partitioned ledger with infra-design. |
| **No premature distribution** | — | At the projected volume a single scanner and single logical ledger partition suffice for MVP; partitioning is designed-in but not activated (`req-nfr-concurrency` — confirm concrete figure at infra-design). |

## Verification

- **Tick-budget smoke at scale**: run one `runScanTick` over a synthetic pending
  set of `N` requests (N at the top of the projected range) and assert completion
  within the ≤ 30 s budget — the concrete cadence-vs-work check.
- **Fan-out safety test**: run two scanner instances over overlapping department
  slices against a shared ledger; assert each `(requestId, stage, tier)` fires
  exactly once (only one append wins), proving partitioning needs no lock
  (`BR-SLA-6`).
- **Linear-growth assertion**: after driving `R` requests through both stages/both
  tiers, assert ledger size ≤ `R × 4` and no re-append of a fired tier.
- **Bounded catch-up test**: simulate missed cadences, then one tick; assert
  recovery work is bounded by current backlog × un-fired tiers, not by elapsed
  downtime (`BR-SLA-6a`).

## Open Items (carried to infrastructure-design)

- Confirm the scan **cadence** and whether horizontal partitioning is warranted
  at the concrete `req-nfr-concurrency` figure (placeholder: single instance, 15
  min).
- Confirm the reminder-ledger **retention horizon** (operational, shorter than
  the audit trail's 7-year window) with infrastructure-design.
- Confirm the production ledger store technology and its single-key read / append
  scaling characteristics jointly with infrastructure-design.
