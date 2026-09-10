# Performance Design — `unit-sla-escalation`

Concrete performance architecture for the **SLA Reminder and Escalation** unit —
the caching, evaluation, batching, resource-pooling, and budget decisions that
satisfy this unit's `performance-requirements`. It is grounded in the idempotent
periodic-scanner shape in `business-logic-model` (SLA Scan Pipeline, `Workflow
S-A`/`S-B`), the timer-driven / idempotent-ledger technology choices in
`tech-stack-decisions` (Scheduling & Concurrency, Persistence), and the
non-blocking / at-most-once invariants those documents carry. The load and
durability envelope come from `scalability-requirements` and
`reliability-requirements`; the PII discipline that shapes what may be cached or
logged comes from `security-requirements`.

The governing performance property, restated from `performance-requirements`:
this unit sits on the **choreography / side-effect** side, not the request path.
**No human waits on a scan tick.** The design objective is therefore *bounded,
predictable batch work per tick that completes well within its cadence* and that
**never inflates the `unit-request-workflow` command budget** it reads from —
not user-facing latency. Correctness (fire each due tier at-most-once) takes
precedence over speed.

## Performance Budgets

Adopted verbatim from `performance-requirements` and made architectural here:

| Operation | Budget | Design mechanism |
|-----------|--------|------------------|
| `evaluate(request, nowMs, policy)` (pure, `Workflow S-B`) | p99 ≤ 1 ms | Pure in-memory arithmetic over the injected clock + policy thresholds; zero I/O; exhaustively unit-tested. |
| `hasFired(requestId, stage, tier)` ledger check | p95 ≤ 20 ms / p99 ≤ 50 ms | Single-key point read on the composite `(requestId, stage, tier)` idempotency key. |
| Single tier dispatch (build message → notification seam) | p95 ≤ 300 ms / p99 ≤ 800 ms | **Inherited** from the `unit-notifications` send budget; this unit adds no new transport (`BR-SLA-12`). |
| Full `runScanTick(nowMs)` at baseline pending volume | ≤ 30 s wall-clock | Comfortably inside the ≥ 15-min cadence so ticks never overlap under normal load. |

The SLA unit's *own* latency contribution is only the policy evaluation and the
ledger read/write; the dispatch tail belongs to the notification seam and is
governed by its budgets, not re-specified here.

## Evaluation Path — Pure, Zero-I/O Core

- **`evaluate` is a pure function.** Per `business-logic-model` `Workflow S-B`,
  classification (`OnTrack | ReminderDue | EscalationDue`) is arithmetic over
  `elapsed = clock.elapsed(enteredAtMs, nowMs, policy.businessHours?)` against
  the injected `EscalationPolicy` thresholds. No I/O means the p99 ≤ 1 ms budget
  is met structurally and the function is deterministic under an injected clock.
- **No per-request round-trip to the workflow aggregate.** The narrowed
  `PendingRequestView` already carries `enteredCurrentStatusAtMs` (derived from
  the workflow's append-only `history`), so `evaluate` never fetches the mutating
  `VacationRequest` — eliminating an N+1 across the unit boundary
  (`performance-requirements` Resource & Efficiency).
- **Business-hours elapsed is a policy flag, not a service call.**
  `clock.elapsed(..., policy.businessHours?)` computes calendar/business-hours
  deltas in-process from configuration (`tech-stack-decisions` Clock), so
  enabling business-hours awareness adds no I/O to the hot evaluation path.

## Batch-Tick Architecture

The tick is designed as **one batch read → in-memory fan-out → guarded, bounded
dispatch**, so cost is dominated by cheap evaluation and only the few
newly-due tiers incur the expensive dispatch path.

```
runScanTick(nowMs):
  1. ONE batch read:  pending = WorkflowPendingQueryPort.listPending()   // not per-request
  2. in-memory loop over pending (each evaluate() ≤ 1 ms, no I/O):
        classify → OnTrack? skip (the overwhelming majority)
  3. for each newly-due (requestId, stage, tier) ONLY:
        hasFired? (single-key read)  → already fired? skip           // idempotency guard
        resolve recipients (late, only for dispatching requests)
        dispatch via notification seam                               // inherited budget
        append ONE ReminderRecord                                    // append-only
  4. return ok(scanSummary)
```

- **One `listPending()` per tick, never per request.** The pending read maps
  onto the workflow's existing scoped `findByDepartmentAndStatus` read and is a
  **read-only narrowed view**; it MUST NOT extend or contend with the workflow
  command budget (`performance-requirements`; `security-requirements` SEC-SLA-2).
  This is the single most important cross-unit performance constraint.
- **Steady-state dispatch is near-zero.** Because the ledger guard
  (`BR-SLA-6`) makes an already-reminded tier a no-op, a steady-state tick over a
  large pending set dispatches for only the few requests that *just* crossed a
  threshold. Work per tick is `O(pending)` for cheap evaluation but `O(newly-due
  tiers)` for the expensive dispatch path (`scalability-requirements`).
- **Late PII resolution adds no hot-path cost.** Contact PII is resolved only for
  requests that actually dispatch, transiently, via the notifications
  `RecipientDirectoryPort` (`security-requirements` SEC-SLA-7). The vast majority
  of evaluated requests never touch the directory.

## Caching Strategy

Caching is deliberately minimal — the tick is background and the hot path is
already zero-I/O — and constrained by the PII posture.

| Candidate | Decision | Rationale |
|-----------|----------|-----------|
| `EscalationPolicy` (thresholds, tiers, business-hours flag) | **Cache in-process for the tick lifetime** (load once at start / on config change) | Read every request; immutable during a tick; fails-closed at load if misconfigured (`BR-SLA-4a`). |
| Pending-request view | **No cache — one fresh batch read per tick** | Eligibility must be derived *freshly* each tick from live workflow state (`reliability-requirements` REL-SLA-5, self-healing); a stale cache would fire against advanced/withdrawn requests. |
| `hasFired` ledger lookups | **No application cache** | Single-key reads are already within budget; a cache would risk a stale "not fired" and a duplicate nudge — correctness over speed. |
| Recipient/contact PII | **Never cached in this unit** | PII resolved late and transiently, never persisted or cached (`security-requirements` SEC-SLA-7). Any directory-side cache is owned by `unit-notifications`, not re-implemented here. |

The one deliberate cache (policy) is the classic *computed-config* case: cheap,
read-heavy, invalidated on config change — not the pending data, which must be
live.

## Resource Pooling & Efficiency

- **Connection reuse via the shared seams.** The unit opens no new transport: it
  reuses the `unit-notifications` send seam (which owns its pooled provider
  client) and the workflow query port (which reads the existing store). Pooling
  for those dependencies is owned by their units; this unit adds only a durable
  **reminder-ledger** client whose access pattern is *single-key point read
  (`hasFired`) + single-row append*, the cheapest possible store shape.
- **Bounded, linear ledger growth.** The ledger appends at most one
  `ReminderRecord` per `(requestId, stage, tier)` — at most 4 per request across
  both stages and both tiers (`performance-requirements`; `scalability-requirements`
  Data Growth). Growth is linear in request count and bounded per request, and the
  `hasFired` single-key read stays fast as the ledger grows behind the port.
- **Catch-up cost is bounded.** After downtime, catch-up fires each un-fired tier
  up to the current one exactly once (`BR-SLA-6a`), so recovery cost is bounded by
  `(backlog requests × un-fired tiers)`, never an unbounded replay
  (`performance-requirements`).

## Async / Cadence Model

- **The tick itself is the async boundary.** There is no synchronous caller;
  dispatch hands off to the notification seam, which is itself asynchronous
  (retry/dead-letter owned there). The SLA unit does not wait on channel delivery
  to complete the tick — a dispatch outcome (including deferred delivery) is
  recorded as a value and the batch continues (`reliability-requirements`
  REL-SLA-8).
- **Cadence vs threshold ratio.** Baseline cadence is **once every 15 minutes**
  (placeholder, confirmed at infrastructure-design), chosen so a 24h-class
  reminder threshold fires within a small fraction of the threshold while tick
  cost stays negligible. The concrete cadence and scheduler binding (cron /
  EventBridge Scheduler) are an infrastructure-design concern isolated behind
  `SchedulerPort` (`tech-stack-decisions` Scheduling).
- **Non-overlapping ticks by budget.** With `runScanTick` ≤ 30 s and a ≥ 15-min
  cadence, ticks do not overlap in normal operation; if they ever do (slow
  downstream), the ledger key makes overlapping/retried ticks idempotent
  (`BR-SLA-6`) so only wasted (bounded) work results, never incorrect behaviour.

## Observability & Verification

- **Per-tick instrumentation.** Emit a `runScanTick` duration histogram plus
  counters for `requests scanned`, `tiers evaluated`, and `notices dispatched`
  tagged by `stage` / `tier` / outcome code (`DISPATCHED | RECIPIENT_UNRESOLVED |
  CHANNEL_DEAD_LETTERED`) so tick cost and dispatch volume are observable against
  the budgets above (`performance-requirements`; detailed reliability
  observability owned by `reliability-design`).
- **Correctness gate is the vitest suite.** The pure `evaluate` function is
  exhaustively unit-tested with a deterministic injected clock; a scan-tick test
  asserts idempotency (a second tick over the same state dispatches nothing —
  `BR-SLA-6`) and catch-up ordering (`BR-SLA-6a`).
- **No load rig.** At this scale (tens–low-hundreds pending per tick) a
  lightweight smoke that runs a tick over a synthetic pending set of `N` requests
  and asserts completion within the ≤ 30 s budget suffices; no dedicated load
  harness is warranted (`performance-requirements`).

## Open Items (carried to infrastructure-design)

- Confirm the concrete scan **cadence** and the deployed scheduler binding (cron
  / EventBridge Scheduler) — placeholder 15 min.
- Confirm concrete SLA **thresholds** per stage/tier from product/HR; the
  illustrative defaults (`TeamLead` 24h/48h, `HR` 48h/96h) set the
  cadence-vs-threshold ratio that keeps tick cost negligible.
- Confirm the durable ledger store's single-key read / append latency
  characteristics so the `hasFired` p95 ≤ 20 ms budget holds in production.
