# Reliability Design — `unit-sla-escalation`

Concrete resilience architecture for the **SLA Reminder and Escalation** unit —
the liveness SLO, at-most-once guarantee, catch-up recovery, degradation tiers,
health checks, retry/failover posture, and backup decisions that satisfy this
unit's `reliability-requirements` (REL-SLA-1..11). It is grounded in the
idempotent-scanner and catch-up semantics in `business-logic-model` (SLA Scan
Pipeline, Data Flow), the append-only idempotent-ledger and no-locking choices in
`tech-stack-decisions` (Concurrency safety, Persistence), the tick budgets in
`performance-requirements`, the single-instance scaling model in
`scalability-requirements`, and the PII-free error taxonomy in
`security-requirements`.

The governing reliability property, restated from `reliability-requirements`:
because the unit is **non-blocking with respect to the workflow** (`BR-SLA-8`), a
failed or delayed reminder is **never a correctness failure of the business
process** — the request was already sitting, and a missed nudge cannot corrupt
request state. The reliability goal is therefore *eventual, at-most-once,
self-healing delivery of nudges* — not the strong transactional consistency the
workflow core demands. This lets the design favour **idempotent recovery over
high-availability machinery**.

## Availability / Liveness SLO

- **REL-DES-1 — Scanner liveness, not request availability (REL-SLA-1).** There
  is no synchronous user request to keep available. The meaningful SLO is that the
  scanner **runs its cadence**: target **≥ 99% of scheduled ticks execute**
  (measured monthly). A tick that runs and returns `ok(scanSummary)` with
  per-request partial outcomes counts as *available* — partial dispatch failures
  are values inside the summary, not tick failures (`business-logic-model`
  `Workflow S-A`). Concrete alerting thresholds TBD with ops (open item).
- **REL-DES-2 — Nudge-timeliness objective (soft) (REL-SLA-2).** A due
  reminder/escalation should dispatch **within one scan cadence of crossing its
  threshold** (placeholder ≤ 15 min). Soft SLO: thresholds are hours-to-days
  (`BR-SLA-4a` illustrative defaults), so a one-cadence delay is immaterial to the
  business intent of `req-sla-reminder-escalation`.
- **REL-DES-3 — Independence from the command path (REL-SLA-3).** Scanner
  availability is fully decoupled from `unit-request-workflow` command
  availability. The scanner reads pending requests read-only; if the workflow read
  is briefly unavailable the tick records a `WORKFLOW_READ_ERROR` value and retries
  next cadence — it never blocks or degrades the workflow's own availability
  (`business-logic-model` Inbound).

## Delivery Semantics & Idempotency

- **REL-DES-4 — At-most-once per `(requestId, stage, tier)` is the core guarantee
  (REL-SLA-4).** Every tier fires at most once per request+stage, enforced by the
  append-only ledger's composite key (`BR-SLA-6`). Overlapping ticks, retried
  ticks, and double-firing schedulers are all safe: **correctness comes from the
  ledger key, not from exactly-once scheduling.** This is the primary
  fault-tolerance mechanism and it replaces distributed locking / leader election
  (`tech-stack-decisions` Concurrency safety; `scalability-requirements`
  fan-out-safe).
- **REL-DES-5 — Self-healing eligibility, no cancellation logic (REL-SLA-5).**
  Eligibility is derived **freshly each tick** from live workflow state
  (`BR-SLA-9`). A request that transitions or is withdrawn between ticks simply
  stops appearing in `listPending()`; no notice fires and no cancellation record
  is needed. There is no stale state to reconcile because the scanner holds no
  copy of request state between ticks.
- **REL-DES-6 — Ledger-append records the decision, not just the send
  (REL-SLA-7).** The ledger append records the *decision to send* with its outcome
  code (`BR-SLA-7`); the notification seam records the *send outcome*
  (`BR-SLA-12`). A record is appended for **every fired tier including failed
  dispatch** (outcome `RECIPIENT_UNRESOLVED` / `CHANNEL_DEAD_LETTERED`), so a tier
  is not re-attempted once a terminal decision is recorded — preventing unbounded
  retry of a genuinely unresolvable target while still capturing the failure as a
  fact.
- **REL-DES-7 — Expected failures are values, not exceptions (REL-SLA-8).**
  Unresolvable contacts, transient channel errors, and workflow-read errors return
  `Result.err` with a PII-free `SlaError` code and leave the batch running
  (`business-logic-model` Error handling). Throwing is reserved for
  `MISCONFIGURED_POLICY` at load (`BR-SLA-4a`) — a transient failure never crashes
  a tick.

## Catch-Up Recovery (the self-healing core)

The catch-up mechanism is what lets this unit favour simplicity over HA
machinery — downtime is *recovered*, not *prevented*.

```
next successful tick after downtime:
  for each pending request:
    classify current tier from live elapsed time
    for each dueTier in tiersUpTo(currentTier):     // e.g. Reminder THEN Escalation
        if ledger.has(requestId, stage, dueTier): continue   // already fired → skip (REL-DES-4)
        dispatch(dueTier); ledger.record(...)                // fire un-fired lower tiers ONCE, in order
```

- **REL-DES-8 — Catch-up after downtime (REL-SLA-6).** If the scanner misses
  cadences, the next successful tick fires each **un-fired** tier up to the current
  one exactly once, **in order** (reminder then escalation) — so a nudge is never
  silently swallowed by downtime or a coarse cadence (`BR-SLA-6a`), and never
  duplicated for tiers already in the ledger (`BR-SLA-6`).
- **REL-DES-9 — Recovery is stateless replay of live state (REL-SLA-10).** After
  any restart the scanner needs no warm-up: the next tick re-derives eligibility
  from the workflow and consults the durable ledger. Recovery correctness depends
  only on the ledger's durability, not on any in-flight scanner state (there is
  none).

## Retry & Failover Posture

Unlike a synchronous service, this unit's "retry" is the *next cadence*, and its
transport retries are *inherited*, not re-implemented.

- **Tick-level retry = next cadence.** A tick that fails wholesale (e.g.
  `WORKFLOW_READ_ERROR`) dispatches nothing and simply runs again on the next
  cadence; catch-up (REL-DES-8) ensures no due tier is lost by the skipped tick.
  No per-tick retry loop is needed — the scheduler *is* the retry.
- **Transport retry/dead-letter is inherited from `unit-notifications`
  (REL-SLA-7).** A transient channel error is retried with backoff then
  dead-lettered by the **notification seam** (notifications `BR-NOTIF-7/10`); the
  in-app copy still lands and the SLA scan still succeeds (`BR-SLA-12`). This unit
  neither defines nor duplicates a circuit breaker / DLQ — it reuses the seam that
  already owns them, consistent with `tech-stack-decisions` (no new transport).
- **Failover is relocation, not replication.** Because the scanner is stateless
  (`scalability-requirements`), failover is "start a scanner elsewhere" — no state
  transfer, no leader handoff. The ledger dedupe makes even a brief two-instance
  overlap safe (REL-DES-4).

## Graceful Degradation Tiers

Mapping each dependency to a tier and behaviour (NFR-design degradation model).
Note the SLA unit is itself an **Important**, not **Critical**, capability — the
app is fully usable if reminders are delayed.

| Dependency | Tier | Degradation behaviour |
|-----------|------|-----------------------|
| Scheduler (`SchedulerPort`) | Important | Missed ticks recovered by catch-up next tick (REL-DES-8); no permanent loss of a due nudge. |
| Workflow pending query (`unit-request-workflow`) | Important | Read fails → tick records `WORKFLOW_READ_ERROR`, dispatches nothing, retries next cadence (REL-DES-3); workflow itself unaffected. |
| Recipient directory (`unit-notifications`) | Important | Unresolvable target → `RECIPIENT_UNRESOLVED` recorded, batch continues; other requests/tiers unaffected (`BR-SLA-5/8`). |
| Notification transport (`unit-notifications`) | Important | Transient failure retried with backoff, then dead-lettered by the notification seam; in-app copy still lands; SLA scan still succeeds (`BR-SLA-12`). |
| Durable reminder ledger | **Critical (to *this unit*)** | Unavailable → cannot guarantee at-most-once; **fail fast and retry next cadence rather than risk duplicate nudges** — the one fail-safe-toward-not-spamming decision (REL-DES-11). |

The ledger is the single dependency the unit will *stop* for: correctness
(at-most-once) outranks liveness, so a ledger outage halts dispatch rather than
risking spam.

## Health Checks

- **Shallow (liveness)**: scanner process up; `SchedulerPort` bound and ticking.
- **Deep (readiness)**: can reach the durable ledger (the critical dependency),
  the workflow query port, and the notification seam. A deep check that finds the
  ledger unreachable is **not-ready** (the unit must not dispatch without its
  dedupe guard — REL-DES-11); a check that finds only the workflow read or a
  channel degraded is *degraded, not dead* — the tick still runs and records the
  degraded outcome as a value.
- **Missed-cadence alerting is the primary reliability signal.** A silently dead
  scanner is the main risk (its failure is invisible to users). Export a
  "ticks executed vs scheduled" metric and alert on missed cadences
  (`reliability-requirements` Open Items) — this is the reliability watchdog for a
  background unit that no human is waiting on.

## Backup, Recovery & Durability

- **REL-DES-10 — Durable append-only ledger in production (REL-SLA-9).**
  Production wires a durable append-only store behind `ReminderLedgerRepository`;
  the in-memory adapter is dev/test only. Committed `ReminderRecord`s survive
  process restart and instance loss, so the at-most-once guarantee holds across
  restarts — a reminder already sent before a crash is not re-sent after recovery
  (`BR-SLA-6/7`).
- **REL-DES-11 — Fail-safe toward not-spamming on ledger loss.** If the durable
  ledger is unavailable, the tick **fails fast and retries next cadence** rather
  than dispatching without the dedupe guard — the deliberate bias is "delay a
  nudge" over "risk a duplicate nudge" (`reliability-requirements` degradation
  table, ledger = Critical-to-this-unit).
- **REL-DES-12 — Operational backup horizon, not compliance (REL-SLA-11).** The
  ledger's backup / point-in-time posture is set jointly with infrastructure-design
  on the **operational** retention horizon — explicitly *not* the 7-year
  `req-nfr-audit-retention` window, which governs the separate compliance
  `audit-trail` owned by `unit-audit-trail`, not this operational ledger
  (`scalability-requirements` Data Growth; `business-logic-model` Own durable
  state).

## Failure-Mode Checklist

- **Scanner down for hours** → catch-up fires each un-fired tier once on recovery
  (REL-DES-8); no duplicates for already-fired tiers (REL-DES-4).
- **Overlapping / double-fired tick** → deduped by the ledger key; each tier still
  fires at most once (REL-DES-4).
- **Request advances or is withdrawn mid-window** → drops out of `listPending()`;
  no notice, no cancellation logic (REL-DES-5; `BR-SLA-9`).
- **Escalation contact unresolvable** → `RECIPIENT_UNRESOLVED` recorded, batch
  continues; the separately-targeted reminder is unaffected (`BR-SLA-5/8`).
- **Email provider persistent failure** → dead-lettered by the notification seam;
  the SLA tick still returns `ok` and the in-app copy still lands (`BR-SLA-12`).
- **Durable ledger outage** → fail fast, dispatch nothing, retry next cadence —
  bias toward not-spamming (REL-DES-11).
- **Misconfigured policy** → fails at load (`MISCONFIGURED_POLICY` throw), never
  scans with a broken policy (`BR-SLA-4a`, fail-closed).
- **Blast radius** → a scanner-instance failure delays nudges by at most one
  cadence and corrupts no state (the workflow aggregate and audit trail are
  untouched); recovery is automatic on the next tick.

## Verification

- **At-most-once / idempotency test**: run two ticks over the same due state;
  assert exactly one dispatch and one `ReminderRecord` per `(requestId, stage,
  tier)` (REL-DES-4).
- **Catch-up ordering test**: simulate a missed reminder cadence so a request is
  past escalation; assert the recovery tick fires reminder *then* escalation, each
  once, in order (REL-DES-8, `BR-SLA-6a`).
- **Self-healing test**: advance/withdraw a request between ticks; assert it drops
  from `listPending()` and no notice/cancellation fires (REL-DES-5).
- **Non-blocking test**: force `WORKFLOW_READ_ERROR` / channel failure; assert the
  tick returns `ok`/records the value and never throws back to or blocks a workflow
  transition (REL-DES-3/7, `BR-SLA-8`).
- **Ledger-loss fail-safe test**: make the ledger unavailable; assert the tick
  dispatches nothing and retries next cadence rather than sending un-guarded
  (REL-DES-11).
- **Restart-durability test**: record a fired tier, restart, re-tick; assert no
  re-send of the already-fired tier (REL-DES-9/10).

## Open Items (carried to infrastructure-design)

- Confirm the tick-liveness SLO and **missed-cadence alerting** (a silently dead
  scanner is the main reliability risk).
- Confirm the durable ledger's **backup cadence and operational retention
  horizon** (distinct from the audit trail's 7-year window) with
  infrastructure-design.
- Confirm the concrete availability/response-time target tracked as
  `req-nfr-availability-tbd` and how it applies to a background scanner vs a
  synchronous path.
