# Performance Requirements — `unit-sla-escalation`

Performance NFRs for the **SLA Reminder and Escalation** unit — the
**timer-driven, off-the-command-path** scanner that watches for vacation
requests sitting too long in a pending stage and fires reminder then escalation
notices. Targets are derived from the idempotent periodic-scanner shape in the
unit's [[business-logic-model]] (SLA Scan Pipeline), the idempotency / non-
blocking invariants in [[business-rules]] (`BR-SLA-6`, `BR-SLA-8`,
`BR-SLA-12`), and the concurrency / response-time and SLA NFRs in
[[requirements]] (`req-sla-reminder-escalation`, `req-nfr-concurrency`,
`req-nfr-availability-tbd`).

The performance posture is fundamentally different from the synchronous units.
This unit sits on the **choreography / side-effect** side, not the request
path: no human waits on a scan tick, and per the business-logic-model
`runScanTick` "never blocks or drives a workflow transition". So the governing
performance property is **not user-facing latency** but **bounded, predictable
batch work per tick that completes well within its cadence** and never inflates
the `unit-request-workflow` command budget it reads from. Correctness (fire
each due tier at-most-once) takes precedence over speed, consistent with the
envelope already shipped across the modular monolith.

## Response-Time Targets

There is no interactive user request in this unit's primary path. Targets are
therefore split between the **pure evaluation function** (which may be called
inline from a status/debug read) and the **batch tick** (background).

| Operation | Target | Rationale |
|-----------|--------|-----------|
| `evaluate(request, nowMs, policy)` (pure, `Workflow S-B`) | p99 ≤ 1 ms | No I/O — arithmetic over the injected clock + policy thresholds ([[business-logic-model]] `Workflow S-B`); exhaustively unit-testable. |
| Single ledger idempotency check `hasFired(requestId, stage, tier)` | p95 ≤ 20 ms / p99 ≤ 50 ms | Single-key lookup on the composite `(requestId, stage, tier)` idempotency key ([[domain-entities]] `ReminderLedgerRepository`). |
| Single tier dispatch (build message → hand to notification seam) | p95 ≤ 300 ms / p99 ≤ 800 ms | Reuses the `unit-notifications` `EmailSenderPort` / `InAppInboxPort`; upper bound reflects the shipped notification send budget, not new transport (`BR-SLA-12`). |
| Full `runScanTick(nowMs)` at baseline pending volume | ≤ 30 s wall-clock | Must complete comfortably inside the scan cadence (see Throughput) so ticks never overlap under normal load. |

- Because dispatch reuses the notification seam, this unit **inherits** the
  notification unit's send latency and its retry/dead-letter behaviour rather
  than defining its own transport budget (`BR-SLA-12`; notifications
  `BR-NOTIF-7/10`). The SLA unit's own contribution to latency is only the
  policy evaluation and the ledger read/write.
- The pending-request read (`WorkflowPendingQueryPort.listPending()`) maps onto
  the workflow's existing scoped read (`findByDepartmentAndStatus` per
  [[business-logic-model]] Data Flow). It is a **read-only narrowed view** and
  MUST NOT extend or contend with the workflow command budget defined in the
  `unit-request-workflow` performance-requirements.

## Throughput & Batch-Tick Budget

- **Bounded work per tick.** Work per tick is `O(pending requests × tiers per
  stage)`. Pending requests are only those in `Submitted` or `Validated`
  ([[business-rules]] `BR-SLA-1`); terminal requests are never scanned
  (`BR-SLA-9`). Given the internal line-of-business scale (low hundreds of
  requests/day at seasonal peak, per the `unit-request-workflow`
  scalability-requirements), the pending set at any tick is small — expected
  **tens, low hundreds** of requests, each evaluated against at most two tiers
  per stage.
- **Scan cadence (placeholder, confirm at nfr-design / infrastructure-design).**
  A cadence of **once every 15 minutes** is the baseline assumption: fine-grained
  enough that a 24h-class reminder threshold ([[business-rules]] `BR-SLA-4a`
  illustrative defaults) fires within a small fraction of the threshold, coarse
  enough that tick cost is negligible. The concrete cadence and the deployed
  scheduler binding (cron / EventBridge Scheduler) are an infrastructure-design
  concern — functional design fixes only the `SchedulerPort` shape
  ([[business-logic-model]] Data Flow; memory open question).
- **At-most-once dispatch dominates cost control.** The ledger idempotency guard
  (`BR-SLA-6`) means a steady-state tick dispatches **zero** notices for the
  overwhelming majority of pending requests (they were already reminded, or are
  still `OnTrack`). Only requests newly crossing a threshold incur a dispatch, so
  per-tick dispatch volume is bounded by the arrival rate at each threshold, not
  by the total pending population.
- **Non-overlapping ticks.** With `runScanTick` budgeted ≤ 30 s and a ≥ 15 min
  cadence, ticks do not overlap in normal operation; if they ever do (slow
  downstream), the ledger key makes overlapping/retried ticks idempotent
  (`BR-SLA-6`) so correctness is unaffected — only wasted work, which is bounded.

## Resource & Efficiency Constraints

- **No N+1 across units.** The tick performs **one** `listPending()` batch read
  from the workflow query port, then per-request in-memory evaluation and at most
  one ledger check + one dispatch + one ledger append per due tier. No per-request
  round-trip to the workflow aggregate (the narrowed `PendingRequestView` already
  carries `enteredCurrentStatusAtMs`, [[domain-entities]]).
- **Catch-up is bounded.** After scanner downtime, catch-up fires each un-fired
  tier up to the current one **exactly once** (`BR-SLA-6a`), so recovery cost is
  bounded by (backlog requests × un-fired tiers), never an unbounded replay.
- **Append-only ledger growth is linear and small.** The ledger appends at most
  one `ReminderRecord` per `(requestId, stage, tier)` — at most 4 records per
  request across both stages and both tiers ([[domain-entities]]
  `ReminderRecord`; `BR-SLA-7`). Growth is linear in request count and bounded per
  request; the `hasFired` lookup is a single-key read that stays fast as the
  ledger grows behind the port.
- **Late PII resolution adds no hot-path cost.** Contact PII is resolved only for
  requests that actually dispatch, transiently, via the notifications
  `RecipientDirectoryPort` (`BR-SLA-5`, `BR-PII-2`) — the vast majority of
  evaluated requests never touch the directory.

## Measurement & Benchmarks

- Instrument each `runScanTick` with a duration histogram plus counters for
  `requests scanned`, `tiers evaluated`, `notices dispatched` (tagged by
  `stage` / `tier` / outcome code `DISPATCHED | RECIPIENT_UNRESOLVED |
  CHANNEL_DEAD_LETTERED`, [[domain-entities]] `SlaOutcomeCode`) so tick cost and
  dispatch volume are observable against this document's budgets (detailed
  observability design is owned by [[reliability-requirements]] and nfr-design).
- The existing `vitest` suite is the correctness gate: the pure `evaluate`
  function is exhaustively unit-tested (deterministic injected clock), and a
  scan-tick test asserts idempotency (a second tick over the same state
  dispatches nothing — `BR-SLA-6`) and catch-up ordering (`BR-SLA-6a`). No load
  rig is warranted at this scale; a lightweight smoke that runs a tick over a
  synthetic pending set of N requests and asserts completion within budget
  suffices.

## Open Items (for NFR-design)

- Confirm the scan **cadence** and the deployed scheduler binding (cron /
  EventBridge Scheduler) — placeholder is 15 min (memory open question).
- Confirm the concrete SLA **thresholds** per stage/tier from product/HR; the
  illustrative defaults (`TeamLead` 24h/48h, `HR` 48h/96h, [[business-rules]]
  `BR-SLA-4a`) set the cadence-vs-threshold ratio that keeps tick cost negligible.
- Reconcile the pending-read cost against the concrete `req-nfr-concurrency`
  figure in [[requirements]] once quantified, ensuring the SLA read never
  contends with the workflow command path.
