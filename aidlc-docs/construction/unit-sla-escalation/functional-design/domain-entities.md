# Vacation Request App — Domain Entities — `unit-sla-escalation`

Entities, value objects, ports, and relationships for the **SLA Reminder and
Escalation** unit. Grounded in the delivery signatures this unit reuses from
[[component-methods]] (`notification` section), the subscriber/side-effect
boundary in [[components]], the choreography placement in [[services]], and the
`unit-sla-escalation — SLA Reminder and Escalation` definition in
[[unit-of-work]]. The single owned story in [[unit-of-work-story-map]]
(`story-sla-escalation`) and its requirement (`req-sla-reminder-escalation` from
[[requirements]]) drive the attributes below.

Design note: identity, the workflow request model, and the notification transport
are **not redefined** here. This unit consumes read-only:

- `PrincipalId` / `AuthenticatedPrincipal` from `unit-platform-auth`
  (`src/domain/entities.ts`),
- the `RequestId`, `RequestStatus`, `WorkflowStage`, `Transition`,
  `DepartmentCode` value objects and the `VacationRequest` *read shape* from
  `unit-request-workflow` (`src/workflow/domain/value-objects.ts`,
  `src/workflow/domain/vacation-request.ts`),
- the `EmailSenderPort`, `InAppInboxPort`, `RecipientDirectoryPort`,
  `RecipientContact`, `EmailMessage`, `InAppNotification`, and `NotificationChannel`
  value objects/ports from `unit-notifications` (`src/notifications/…`).

It adds only the SLA-side value objects (policy, tier, evaluation), the
append-only reminder ledger, and the two scanning/scheduling ports — concepts no
other unit models. Cross-unit references use **ids, not object graphs** (least
coupling), matching the boundary the workflow and notification units established.

## Value Objects

All value objects are immutable; equality is by attribute value (DDD value-object
semantics), consistent with the shipped `LeaveBalance` / `Session` / `DedupeKey`
style.

### `SlaStage`
- Alias/reuse of the workflow `WorkflowStage` (`TeamLead` | `HR`) — the pending
  stage a request is waiting in. Reused, not redefined, so a stage means the same
  thing across units.

### `SlaTier` (enum-like)
- Members: `OnTrack`, `ReminderDue`, `EscalationDue` (for evaluation) and the
  fired-tier tags `Reminder`, `Escalation` (for the ledger). `OnTrack` never
  fires. Ordered: `Reminder` precedes `Escalation` (`BR-SLA-4`).

### `SlaThresholds`
- Per-stage config fragment: `reminderAfterMs: number`, `escalateAfterMs: number`
  with invariant `0 < reminderAfterMs < escalateAfterMs` (`BR-SLA-4/4a`).

### `EscalationPolicy`
- Map keyed by `SlaStage` → `SlaThresholds`, plus `businessHours?: boolean`
  (elapsed-time mode, `BR-SLA-3`) and an optional per-tier `copyOwner` /
  `escalationContact` recipient configuration (`BR-SLA-5`). Injected
  configuration; validated monotonic at load (`BR-SLA-4a`). Prefer this value
  object over scattered primitives (value-object-over-primitive heuristic, as with
  `DateRange` / `NotificationTemplate` upstream).

### `SlaEvaluation` (pure result of `evaluate`)
- `requestId`: `RequestId`.
- `stage`: `SlaStage` (the pending stage).
- `elapsedMs`: `number` (per `BR-SLA-2/3`).
- `tier`: `SlaTier` (`OnTrack | ReminderDue | EscalationDue`).
- `thresholds`: `SlaThresholds` (the stage's config, for transparency/debug).
- No identity — a computed snapshot; equality by value.

### `SlaError` (value-level failure)
- `code`: `MISCONFIGURED_POLICY` | `RECIPIENT_UNRESOLVED` | `CHANNEL_ERROR` |
  `WORKFLOW_READ_ERROR`.
- PII-free message. Mirrors the `SsoError` / `AuthzError` / `WorkflowError` /
  `NotificationError` taxonomy convention already shipped; returned inside
  `Result<T, SlaError>` per the existing `result.ts` convention, **not thrown**
  (throwing reserved for `MISCONFIGURED_POLICY` at load — the one misconfiguration
  case, `BR-SLA-4a`).

### `PendingRequestView` (read-only projection from `unit-request-workflow`)
- The narrowed, PII-free snapshot the scan consumes — **not** the mutable
  aggregate:
- `requestId`: `RequestId`; `ownerId`: `PrincipalId`; `department`:
  `DepartmentCode`; `status`: `RequestStatus` (always non-terminal here);
  `enteredCurrentStatusAtMs`: `number` (derived from the latest `Transition` into
  `status`, `BR-SLA-2`).
- This view is produced by the `WorkflowPendingQueryPort`; the SLA unit never
  receives the `VacationRequest` object graph (least coupling, ids only).

## Entities & Aggregates

### `ReminderRecord` (append-only operational record — the unit's core state)

One record per fired `(requestId, stage, tier)`; the idempotency guard and the
SLA-decision fact trail. **Append-only** and never mutated (`BR-SLA-7`) — an
operational trail, distinct from both the compliance `audit-trail` (owned by
`unit-audit-trail`) and the notification unit's `NotificationDelivery`.

| Attribute | Type | Notes |
|-----------|------|-------|
| `requestId` | `RequestId` | The subject request (id ref, not object). |
| `stage` | `SlaStage` | Which pending stage the notice was for (`BR-SLA-2`). |
| `tier` | `SlaTier` | `Reminder` or `Escalation` (`OnTrack` never recorded). |
| `outcome` | `SlaOutcomeCode` | PII-free: `DISPATCHED` / `RECIPIENT_UNRESOLVED` / `CHANNEL_DEAD_LETTERED` (`BR-SLA-10`). |
| `firedAtMs` | `number` | When the tier fired. |

Identity is the composite `(requestId, stage, tier)` — the idempotency key
(`BR-SLA-6`). Write-once; no field is edited after creation.

## Ports (hexagonal seams — one responsibility each)

### `SchedulerPort` (inbound — this unit's trigger)
- `onTick(handler: (nowMs: number) => Promise<void>): void` (or an external cron
  simply calls `runScanTick(nowMs)`). Abstracts the timer so dev/test drive ticks
  manually and prod wires cron / EventBridge Scheduler. This is the seam that
  makes the unit **timer-driven, not event-driven** — the key distinction from
  `unit-notifications` (`business-logic-model`).

### `WorkflowPendingQueryPort` (read-only, from `unit-request-workflow`)
- `listPending(): Promise<PendingRequestView[]>` — all requests in `Submitted` or
  `Validated`. Maps onto the workflow repository's existing
  `findByDepartmentAndStatus` scoped read; the SLA unit sees a **narrowed view**,
  never the mutating aggregate API (`BR-SLA-1`, boundary preserved).
- `findById(requestId): Promise<PendingRequestView | null>` — for a single-request
  evaluation/debug read.

### `ReminderLedgerRepository` (append-only, owned by this unit)
- `hasFired(requestId, stage, tier): Promise<boolean>` — the idempotency guard
  (`BR-SLA-6`).
- `record(record: ReminderRecord): Promise<void>` — append-only (`BR-SLA-7`);
  never updates/deletes. The in-memory adapter is the dev/test implementation,
  swappable for a durable append-only store (same seam as
  `NotificationDeliveryRepository` / `AuditStore`).

### Reused notification ports (read-only dependencies, **not redefined**)
- `RecipientDirectoryPort` (`resolve` / `resolveActor`) — resolve owner, pending
  actor, and escalation contact to a `RecipientContact` (`BR-SLA-5`).
- `EmailSenderPort.send(EmailMessage)` and `InAppInboxPort.put(InAppNotification)`
  — the transport this unit reuses; retry/dead-letter reliability is inherited
  (`BR-SLA-12`, notifications `BR-NOTIF-7/10`).

## Consumed Contracts (read-only, from dependency units)

This unit defines **no** new event or request contract. It reads:

- From `unit-request-workflow`: `RequestStatus` (to select `Submitted` /
  `Validated`), `WorkflowStage`, and `Transition.atMs` (the per-stage SLA clock,
  `BR-SLA-2`) — via `WorkflowPendingQueryPort`, never the mutating aggregate.
- From `unit-notifications`: the `EmailSenderPort` / `InAppInboxPort` /
  `RecipientDirectoryPort` seam and the `EmailMessage` / `InAppNotification`
  shapes — reused verbatim so a reminder/escalation is delivered on the same rails
  as a state-change notification.

## Relationships & Lifecycle

```
SchedulerPort ──onTick(nowMs)──► SlaService.runScanTick(nowMs)
                                          │
     WorkflowPendingQueryPort.listPending() ──► PendingRequestView[]   (read-only, ids only, PII-free)
                                          │
             for each: evaluate(view, nowMs, policy) ──► SlaEvaluation { stage, elapsedMs, tier }
                                          │  tier ∈ {ReminderDue, EscalationDue}
                                          ▼
             ReminderLedgerRepository.hasFired(requestId, stage, tier)?  ── yes ──► skip (idempotent, BR-SLA-6)
                                          │ no
       escalationRecipients(view, stage, tier) ──resolve──► RecipientDirectoryPort (read-only, PII late)
                                          │
                 renderReminder/renderEscalation (SLA templates)
                                          │
                 ┌────────────────────────┴────────────────────────┐
                 ▼                                                   ▼
     EmailSenderPort.send(EmailMessage)                 InAppInboxPort.put(InAppNotification)   (reused from unit-notifications)
                 └────────────────────────┬────────────────────────┘
                                          ▼
                 ReminderLedgerRepository.record(ReminderRecord)   (append-only, PII-free, BR-SLA-7/10)
```

Lifecycle of a request through this unit's eyes: it becomes eligible when it
enters `Submitted` or `Validated`; accrues at most one `Reminder` then one
`Escalation` per stage as its stage clock crosses thresholds; and silently exits
scope the moment it transitions or is withdrawn (`BR-SLA-9`) — no cancellation
record is needed because eligibility is derived freshly each tick. `ReminderRecord`
entries are write-once and outlive the request's pending window as the SLA
decision trail.

Cross-unit references use **ids, not object graphs**: the SLA unit holds
`RequestId` / `PrincipalId` / `DepartmentCode` refs, reads a narrowed
`PendingRequestView`, and resolves contact PII only at dispatch — never receiving
or storing the `VacationRequest` aggregate itself, preserving the least-coupling
boundary the `unit-request-workflow` and `unit-notifications` `domain-entities`
established.
