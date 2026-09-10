# Vacation Request App — Business Logic Model — `unit-sla-escalation`

Functional design for the **SLA Reminder and Escalation** unit — the
**timer-driven** side-effect that watches for vacation requests sitting too long
in a stage awaiting action and nudges (reminder) then escalates (breach) by
sending notifications. This unit is the *scheduling* half that
[[unit-of-work]] and the `unit-notifications` design explicitly deferred: the
notification unit owns the **send capability**; this unit owns **when** to send
reminder/escalation notices.

Scope is bound to the single story the [[unit-of-work-story-map]] assigns to
`unit-sla-escalation` (`map-unit-sla-escalation`):

- `story-sla-escalation` — SLA reminder and escalation notifications
  (`could-have`), covering `req-sla-reminder-escalation` (`should-have`) from
  [[requirements]].

Per the [[unit-of-work]] `unit-sla-escalation — SLA Reminder and Escalation`
definition, this unit **depends on `unit-request-workflow`** (source of the
pending requests and their timeline) and **`unit-notifications`** (the send
seam) — both already completed. The [[components]] architecture and
[[component-methods]] (`notification` section) place delivery in the
`notification` component; this unit adds a scheduling/policy layer on top and
reuses the shipped delivery ports rather than re-implementing them. Per
[[services]] this unit is on the **choreography / side-effect** side, not the
synchronous command path — it never blocks or drives a workflow transition.

## Design Approach

The unit is modelled as an **idempotent periodic scanner** behind a scheduler
port. On each tick it:

1. **Enumerates pending requests** — requests whose current `RequestStatus` is
   non-terminal and *awaiting an actor*: `Submitted` (awaiting `TeamLead`) or
   `Validated` (awaiting `HR`). These are read **read-only** from
   `unit-request-workflow` through a query port; this unit never mutates the
   `VacationRequest` aggregate (owned by that unit — least coupling, mirroring how
   `unit-notifications` consumes but never calls the workflow back).
2. **Computes elapsed pending time** for each — the wall-clock (config-selectable
   business-hours) delta between *now* and the `atMs` of the transition that put
   the request into its current pending stage. That timestamp comes from the
   workflow's append-only `history: Transition[]` (`unit-request-workflow`
   `domain-entities`), so **no new timestamp field is introduced** on the
   request.
3. **Evaluates the SLA policy** — maps elapsed time against an ordered set of
   **tiers** (`Reminder`, `Escalation`) with per-stage thresholds. The policy is
   injected configuration (`req-sla-reminder-escalation` states the behaviour but
   fixes no numbers; the raw intent fixes none either — see `memory.md`).
4. **Fires each due tier at-most-once per request+stage** — guarded by an
   append-only **reminder ledger** owned by this unit, keyed by
   `(requestId, stage, tier)`. This makes every tick idempotent: a request that
   already got its `Reminder` at the `TeamLead` stage is not reminded again on the
   next tick; it only advances when it crosses the `Escalation` threshold.
5. **Dispatches** the due notice by **reusing the `unit-notifications` send
   seam** — `EmailSenderPort` and `InAppInboxPort` (`unit-notifications`
   `domain-entities` ports) — resolving recipients through the same
   `RecipientDirectoryPort`. This unit contributes the *reason to send* (an SLA
   reminder/escalation), not new transport.

Like the notification unit, this unit is **at-least-once + idempotent** (a
scheduler may double-fire, a tick may be retried): correctness comes from the
ledger's `(requestId, stage, tier)` dedupe key, not from exactly-once
scheduling. It is **non-blocking with respect to the workflow** — a reminder
failure is retried/dead-lettered, never surfaced back to a workflow transition
(the request has already been sitting; a failed nudge cannot corrupt request
state).

Error handling follows the shipped `Result<T, E>` convention
(`src/domain/result.ts`): expected failures (unresolvable escalation contact,
transient channel error) are returned as `Result.err` values carrying a
PII-free, machine-readable code — never thrown. PII discipline matches the
established chain (`req-nfr-security-pii`, workflow `BR-INV-6`, notifications
`BR-PII-*`): the scanner works from pseudonymous ids (`requestId`, `ownerId`,
`department`, `actorId`) only; recipient contact PII is resolved **late** at send
time and never logged or persisted in the ledger.

The unit exposes one primary capability plus a supporting read, aligned with the
delivery shapes fixed by [[component-methods]] (`notification` section) that it
reuses:

1. **Run one SLA scan tick** — the scheduler entry point (enumerate → evaluate →
   dispatch due notices → record ledger).
2. **Evaluate SLA state for one request** — a pure, unit-testable policy function
   (also usable for a status/debug read) that classifies a request into
   `OnTrack | ReminderDue | EscalationDue` given elapsed time and the policy.

## SLA Scan Pipeline (per scheduler tick)

```
scheduler tick (SchedulerPort) at nowMs
        │
        ▼
runScanTick(nowMs):
  1. enumerate pending requests (read-only, from unit-request-workflow):
        pending = WorkflowPendingQueryPort.listPending()   // status ∈ {Submitted, Validated}
  2. for each request:
        stage       = pendingStageOf(status)               // Submitted→TeamLead, Validated→HR
        enteredAtMs  = latestTransitionInto(status).atMs    // from request.history (BR-SLA-2)
        elapsed      = clock.elapsed(enteredAtMs, nowMs, policy.businessHours?)  // BR-SLA-3
        tier         = policy.classify(stage, elapsed)      // OnTrack|ReminderDue|EscalationDue (BR-SLA-4)
        if tier == OnTrack: continue
        for each dueTier in tiersUpTo(tier):                // catch-up: fire skipped lower tiers once
            if ledger.has(requestId, stage, dueTier): continue          // idempotency guard (BR-SLA-6)
            recipients = escalationRecipients(request, stage, dueTier)  // BR-SLA-5
            outcome    = dispatch(dueTier, request, recipients)         // reuse notification send seam
            ledger.record(requestId, stage, dueTier, outcome, nowMs)    // append-only (BR-SLA-7)
  3. return ok(scanSummary)   // per-request/per-tier outcomes; never workflow-blocking (BR-SLA-8)
```

- **Idempotent per tick.** Re-running the same tick (or an overlapping tick) is a
  no-op for tiers already in the ledger — pairs with the workflow's own
  optimistic-concurrency posture and the notifications `BR-NOTIF-9` idempotency
  philosophy.
- **Stage-scoped clock.** When a request advances `Submitted → Validated`, the
  `TeamLead`-stage timers stop mattering and a *fresh* `HR`-stage clock starts
  from the `Validated` transition's `atMs`; ledger keys include `stage` so the two
  stages are independent (`BR-SLA-2`).
- **Terminal requests are never scanned.** `Approved`/`Rejected`/`Withdrawn` are
  terminal (`unit-request-workflow` `RequestStatus`) and are excluded by the
  pending query — a withdrawn/decided request stops accruing SLA (`BR-SLA-9`).

### Workflow S-A — Run one SLA scan tick (`runScanTick`)

Input: `nowMs` (injected clock). Output: `Result<ScanSummary, SlaError>` — the
summary reports per-request/per-tier dispatch outcomes; it is *never* a
workflow-blocking error.

```
runScanTick(nowMs):
  1. list pending requests (read-only workflow query)
  2. for each: compute stage + elapsed; classify against policy
  3. for each due, not-yet-fired (requestId, stage, tier):
        resolve escalation recipients; dispatch reminder/escalation notice
        append a ReminderRecord to the ledger (idempotency + audit-of-nudges)
  4. return ok(summary)   // partial failures are values inside the summary
```

### Workflow S-B — Evaluate SLA state for one request (`evaluate`)

Input: a `VacationRequest` snapshot (or its `{ status, history }`), `nowMs`, and
the `EscalationPolicy`. Output: `SlaEvaluation { stage, elapsedMs, tier,
thresholds }` — a **pure** function, no I/O, so it is exhaustively unit-testable
(the same pure-core discipline as the workflow FSM aggregate and the
notification `recipientPolicy`).

```
evaluate(request, nowMs, policy):
  1. if status is terminal → OnTrack (nothing pending)               [BR-SLA-9]
  2. stage = pendingStageOf(status)
  3. enteredAtMs = latestTransitionInto(status).atMs                  [BR-SLA-2]
  4. elapsed = clock.elapsed(enteredAtMs, nowMs, policy.businessHours)[BR-SLA-3]
  5. tier = highest threshold in policy[stage] that elapsed exceeds   [BR-SLA-4]
  6. return { stage, elapsedMs: elapsed, tier, thresholds: policy[stage] }
```

## Data Flow & Integration Points

- **Inbound (schedule, not events)**: a `SchedulerPort` invokes `runScanTick` on
  a cadence (cron / EventBridge Scheduler in prod; an in-process interval or
  manual call in dev/test). Unlike `unit-notifications`, this unit is **not** an
  `EventPublisher` subscriber — reminders fire on the *absence* of a transition
  (elapsed time), which no event can signal. This is the core reason a separate
  unit exists (see `memory.md` interpretation).
- **Pending-request read (read-only, from `unit-request-workflow`)**: a
  `WorkflowPendingQueryPort` exposes `listPending()` and `findById(requestId)`
  returning PII-free request snapshots (`requestId`, `ownerId`, `department`,
  `status`, `history` timestamps). This maps onto the workflow repository's
  existing scoped reads (`findByDepartmentAndStatus` in `unit-request-workflow`
  `domain-entities`) — the SLA unit consumes a **narrowed query view**, never the
  mutating aggregate API, preserving the boundary the workflow unit established.
- **Recipient resolution (read-only)**: reuses `unit-notifications`'
  `RecipientDirectoryPort` — `resolve(principalId)` for the owner/pending actor
  and `resolveActor(department, role)` to find the escalation target (e.g. the
  team lead of dept X for a reminder, HR / the lead's manager for an escalation —
  exact target is an open question in `memory.md`).
- **Outbound channels (reused ports)**: `EmailSenderPort.send(EmailMessage)` and
  `InAppInboxPort.put(InAppNotification)` from `unit-notifications`. This unit
  builds SLA-flavoured messages from its own templates but hands them to the
  **same** transport seam — no new email/in-app transport is introduced
  (least-coupling; the notifications `business-logic-model` explicitly anticipates
  this reuse: *"the SLA unit reuses this unit's send capability … it does not own
  the scheduling"*).
- **Own durable state — the reminder ledger**: an append-only
  `ReminderLedgerRepository` records one `ReminderRecord` per fired
  `(requestId, stage, tier)`. This is the idempotency + operability surface; it is
  **distinct from** the compliance `audit-trail` (owned by `unit-audit-trail`) and
  from the notification unit's `NotificationDelivery` record — it captures *SLA
  decisions*, not raw sends.
- **PII posture (`req-nfr-security-pii`)**: the scan works from pseudonymous ids;
  the ledger stores only ids, stage, tier, outcome code, and timestamps — **no
  email, name, or free-text reason** (`BR-SLA-10`, mirroring notifications
  `BR-PII-4` and audit `BR-AUD-8`). Contact PII is resolved transiently at
  dispatch and never logged.

Persistence for the reminder ledger and the query/scheduler bindings live behind
ports so the in-memory dev/test adapters can be swapped for durable/cron-backed
implementations in production without changing the scan logic — the same
port/adapter seam every shipped unit uses (`SessionStore`, `RoleDirectoryPort`,
`BalanceCache`, `EventPublisher`, `InAppInboxPort`).
