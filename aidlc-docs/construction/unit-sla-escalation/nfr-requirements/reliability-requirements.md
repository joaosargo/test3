# Reliability Requirements — `unit-sla-escalation`

Reliability NFRs for the **SLA Reminder and Escalation** unit — availability,
fault tolerance, idempotency, degradation, and recovery for the timer-driven
scanner. Targets derive from the idempotent-scanner design and catch-up
semantics in [[business-logic-model]] (SLA Scan Pipeline, Data Flow), the
at-most-once / non-blocking / self-healing invariants in [[business-rules]]
(`BR-SLA-6`, `BR-SLA-6a`, `BR-SLA-8`, `BR-SLA-9`, `BR-SLA-12`), and the
availability and SLA NFRs in [[requirements]] (`req-sla-reminder-escalation`,
`req-nfr-availability-tbd`).

The reliability profile is distinctive: because the unit is **non-blocking with
respect to the workflow** ([[business-rules]] `BR-SLA-8`), a failed or delayed
reminder is **never a correctness failure of the business process** — the
request was already sitting, and a missed nudge cannot corrupt request state.
The reliability goal is therefore *eventual, at-most-once, self-healing
delivery of nudges* — not the strong transactional consistency the workflow
core demands. This lets the unit favour simplicity and idempotent recovery over
high-availability machinery.

## Availability Targets (SLO)

- **REL-SLA-1 — Scanner liveness, not request availability.** There is no
  synchronous user request to keep available. The meaningful SLO is that the
  scanner **runs its cadence**: target **≥ 99% of scheduled ticks execute**
  (measured monthly), with any missed ticks recovered by catch-up on the next
  successful tick (`BR-SLA-6a`). A tick that runs and returns `ok(scanSummary)`
  with per-request partial outcomes counts as available — partial dispatch
  failures are values inside the summary, not tick failures
  ([[business-logic-model]] `Workflow S-A`).
- **REL-SLA-2 — Nudge-timeliness objective (soft).** A due reminder/escalation
  should be dispatched **within one scan cadence of crossing its threshold**
  (placeholder ≤ 15 min, per [[performance-requirements]]). This is a soft SLO:
  because thresholds are hours-to-days ([[business-rules]] `BR-SLA-4a`
  illustrative defaults), a one-cadence delay is immaterial to the business
  intent of `req-sla-reminder-escalation`.
- **REL-SLA-3 — Independence from the command path.** Scanner availability is
  fully decoupled from `unit-request-workflow` command availability. The scanner
  reads pending requests read-only; if the workflow read is briefly unavailable,
  the tick records a `WORKFLOW_READ_ERROR` value and retries next cadence — it
  never blocks or degrades the workflow's own availability
  ([[business-logic-model]] Inbound; [[domain-entities]] `SlaError`).

## Consistency, Idempotency & Fault Tolerance

- **REL-SLA-4 — At-most-once per (requestId, stage, tier) is the core guarantee.**
  Every tier fires at most once per request+stage, enforced by the append-only
  ledger's composite key ([[business-rules]] `BR-SLA-6`; [[domain-entities]]
  `ReminderRecord`). Overlapping ticks, retried ticks, and double-firing
  schedulers are all safe: correctness comes from the ledger key, **not** from
  exactly-once scheduling. This is the primary fault-tolerance mechanism.
- **REL-SLA-5 — Self-healing eligibility, no cancellation logic.** Eligibility is
  derived **freshly each tick** from live workflow state ([[business-rules]]
  `BR-SLA-9`). A request that transitions or is withdrawn between ticks simply
  stops appearing in `listPending()`; no notice fires and no cancellation record
  is needed. There is no stale-state to reconcile because the scanner holds no
  copy of request state between ticks.
- **REL-SLA-6 — Catch-up after downtime.** If the scanner misses cadences, the
  next successful tick fires each **un-fired** tier up to the current one exactly
  once, in order (reminder then escalation) — so a nudge is never silently
  swallowed by downtime or a coarse cadence ([[business-rules]] `BR-SLA-6a`), and
  never duplicated for tiers already in the ledger (`BR-SLA-6`).
- **REL-SLA-7 — Ledger-append ordering vs dispatch.** The ledger append records
  the *decision to send* with its outcome code ([[business-rules]] `BR-SLA-7`);
  the notification seam records the *send outcome* (`BR-SLA-12`). A record is
  appended for every fired tier including failed dispatch (outcome
  `RECIPIENT_UNRESOLVED` / `CHANNEL_DEAD_LETTERED`), so a tier is not re-attempted
  once a terminal decision is recorded — preventing unbounded retry of a
  genuinely unresolvable target while still capturing the failure as a fact.
- **REL-SLA-8 — Expected failures are values, not exceptions.** Unresolvable
  contacts, transient channel errors, and workflow-read errors return `Result.err`
  with a PII-free `SlaError` code and leave the batch running
  ([[business-logic-model]] Error handling; [[domain-entities]] `SlaError`).
  Throwing is reserved for `MISCONFIGURED_POLICY` at load ([[business-rules]]
  `BR-SLA-4a`) — a transient failure never crashes a tick.

## Durability, Backup & Recovery

- **REL-SLA-9 — Durable append-only ledger in production.** Production wires a
  durable append-only store behind `ReminderLedgerRepository`
  ([[domain-entities]]); the in-memory adapter is dev/test only. Committed
  `ReminderRecord`s survive process restart and instance loss, so the
  at-most-once guarantee holds across restarts — a reminder already sent before a
  crash is not re-sent after recovery ([[business-rules]] `BR-SLA-6/7`).
- **REL-SLA-10 — Recovery is stateless replay of live state.** After any restart
  the scanner needs no warm-up: the next tick re-derives eligibility from the
  workflow and consults the durable ledger. Recovery correctness depends only on
  the ledger's durability, not on any in-flight scanner state (there is none).
- **REL-SLA-11 — Backup consistent with operational retention.** The ledger's
  backup / point-in-time posture is set jointly with infrastructure-design on the
  **operational** retention horizon — explicitly *not* the 7-year
  `req-nfr-audit-retention` window, which governs the separate compliance
  `audit-trail` owned by `unit-audit-trail`, not this operational ledger
  ([[business-logic-model]] Own durable state; see [[scalability-requirements]]).

## Graceful Degradation

Mapping each dependency to a degradation tier (per the NFR-design degradation
model). Note the SLA unit is itself an **Important**, not **Critical**,
capability — the app is fully usable if reminders are delayed.

| Dependency | Tier | Degradation behaviour |
|-----------|------|-----------------------|
| Scheduler (`SchedulerPort`) | Important | Missed ticks recovered by catch-up next tick (`BR-SLA-6a`); no permanent loss of a due nudge. |
| Workflow pending query (`unit-request-workflow`) | Important | Read fails → tick records `WORKFLOW_READ_ERROR`, dispatches nothing, retries next cadence (`REL-SLA-3`); workflow itself unaffected. |
| Recipient directory (`unit-notifications`) | Important | Unresolvable target → `RECIPIENT_UNRESOLVED` recorded, batch continues; other requests/tiers unaffected (`BR-SLA-5/8`). |
| Notification transport (`unit-notifications`) | Important | Transient failure retried with backoff, then dead-lettered by the notification seam; in-app copy still lands; SLA scan still succeeds (`BR-SLA-12`, notifications `BR-NOTIF-7/10`). |
| Durable reminder ledger | Critical (to *this unit*) | Unavailable → cannot guarantee at-most-once; tick should fail fast and retry rather than risk duplicate nudges (fail-safe toward not-spamming). |

## Failure-Mode Checklist

- **Scanner down for hours** → catch-up fires each un-fired tier once on recovery
  (`REL-SLA-6`); no duplicates for already-fired tiers (`REL-SLA-4`).
- **Overlapping / double-fired tick** → deduped by the ledger key; each tier
  still fires at most once (`REL-SLA-4`).
- **Request advances or is withdrawn mid-window** → drops out of `listPending()`;
  no notice, no cancellation logic (`REL-SLA-5`, [[business-rules]] `BR-SLA-9`).
- **Escalation contact unresolvable** → `RECIPIENT_UNRESOLVED` recorded, batch
  continues; the separately-targeted reminder is unaffected (`BR-SLA-5/8`).
- **Email provider persistent failure** → dead-lettered by the notification seam;
  the SLA tick still returns `ok` and the in-app copy still lands (`BR-SLA-12`).
- **Misconfigured policy** → fails at load (`MISCONFIGURED_POLICY` throw), never
  scans with a broken policy ([[business-rules]] `BR-SLA-4a`, fail-closed).
- **Blast radius** → a scanner-instance failure delays nudges by at most one
  cadence and corrupts no state (the workflow aggregate and audit trail are
  untouched); recovery is automatic on the next tick.

## Open Items (for nfr-design)

- Confirm the tick-liveness SLO and alerting on **missed cadences** (a silently
  dead scanner is the main reliability risk, since its failure is invisible to
  users).
- Confirm the durable ledger's backup cadence and **operational** retention
  horizon (distinct from the audit trail's 7-year window) with
  infrastructure-design.
- Confirm the concrete availability/response-time target tracked as
  `req-nfr-availability-tbd` in [[requirements]] and how it applies to a
  background scanner vs a synchronous path.
