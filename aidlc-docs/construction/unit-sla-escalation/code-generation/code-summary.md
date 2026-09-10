# Code Summary — `unit-sla-escalation`

Implementation summary for the **SLA Reminder and Escalation** unit — the
timer-driven scanner that nudges (reminder) then escalates (breach) vacation
requests sitting too long awaiting an actor. Realises `story-sla-escalation` /
`req-sla-reminder-escalation`, grounded in the unit's `business-logic-model`,
`domain-entities`, `business-rules`, `tech-stack-decisions`, and
`logical-components`, and scoped by the `unit-of-work` definition. Follows the
approved `code-generation-plan`.

The unit **adds no new runtime, framework, or transport** — it consumes
`unit-request-workflow` (read-only pending view) and `unit-notifications` (send
seam + directory) verbatim, by id, and never mutates the workflow aggregate.

## Files Created

All source under `src/sla-escalation/` (mirrors the shipped per-unit layout).

### Domain (`domain/`)
- `value-objects.ts` — `SlaStage` (reuse of `WorkflowStage`), `SlaEvaluationTier`
  (`OnTrack|ReminderDue|EscalationDue`), `SlaTier` (`Reminder|Escalation`),
  `SlaOutcomeCode`, `SlaThresholds`, `EscalationPolicy`, `PendingRequestView`,
  `SlaEvaluation`, and the illustrative `DEFAULT_ESCALATION_POLICY` (`BR-SLA-4/4a/10`).
- `errors.ts` — `SlaError` taxonomy (`MISCONFIGURED_POLICY | RECIPIENT_UNRESOLVED
  | CHANNEL_ERROR | WORKFLOW_READ_ERROR`), PII-free, mirrors `NotificationError`;
  `throwMisconfigured` (the one allowed throw, `BR-SLA-4a`).
- `reminder-record.ts` — append-only `ReminderRecord` + `reminderKey`
  `(requestId, stage, tier)` idempotency key (`BR-SLA-6/7`).
- `sla-policy.ts` — the **pure**, zero-I/O core: `pendingStageOf`, `elapsedMs`,
  `classify`, `tiersUpTo` (catch-up), `evaluate`, `validatePolicy` (fail-closed)
  (`business-logic-model` Workflow S-B; `BR-SLA-2/3/4/4a/6a/9`).
- `templates.ts` — PII-free SLA reminder/escalation in-app + email renderers
  (`BR-PII-1/2`).

### Ports (`ports/`)
- `scheduler-port.ts` — `SchedulerPort` (the timer seam — the distinguishing
  trait vs the event-driven notification unit).
- `workflow-pending-query-port.ts` — read-only `listPending` / `findById`
  → `PendingRequestView` (`BR-SLA-1`).
- `reminder-ledger-repository.ts` — append-only `hasFired` / `record`
  (`BR-SLA-6/7`).

### Services (`services/`)
- `sla-scan-service.ts` — `SlaScanService.runScanTick(nowMs)` (enumerate →
  pure `evaluate` → catch-up dispatch due un-fired tiers → append ledger;
  always `ok(ScanSummary)`, never blocking, `BR-SLA-1/5/6/6a/7/8/11/12`) and
  `evaluateById` (Workflow S-B read). Dispatch reuses the notification
  `EmailSenderPort` / `InAppInboxPort` / `RecipientDirectoryPort` verbatim.

### Adapters (`adapters/`)
- `in-memory-reminder-ledger.ts` — append-only dev/test ledger with a test accessor.
- `workflow-pending-query-adapter.ts` — maps the workflow repository's scoped
  `findByDepartmentAndStatus` into the narrowed PII-free view; per-stage clock
  read read-only from `Transition.atMs` (`BR-SLA-2`); excludes terminal
  requests (`BR-SLA-9`).
- `interval-scheduler.ts` — in-process `setInterval` + manual `tick(nowMs)` for
  deterministic tests; swallows tick failures (`BR-SLA-8`).

### HTTP (`http/`)
- `sla-router.ts` — optional guarded debug read
  `GET /sla/requests/:requestId/evaluate`, composed on
  `requireSession → requirePermission('request:view-department')`; returns a
  PII-free `SlaEvaluation` or 404 (`logical-components` C9; `security-design`
  SEC-DES-4).

### Wiring & surface
- `subscribe.ts` — `registerSlaScheduler(scheduler, service)` binds the timer to
  `runScanTick`.
- `index.ts` — the encapsulated public surface (mirrors
  `src/workflow/index.ts` / `src/notifications/index.ts`).

### Tests
- `domain/sla-policy.test.ts` (18) — exhaustive pure evaluate/classify/
  tiersUpTo/validatePolicy.
- `domain/templates.test.ts` (5) — PII-free rendering.
- `services/sla-scan-service.test.ts` (13) — idempotency (`BR-SLA-6`), catch-up
  (`BR-SLA-6a/11`), HR-stage clock, recipient-unresolved (`BR-SLA-5/8`),
  terminal self-heal (`BR-SLA-9`), injected escalation contact (`BR-SLA-5`),
  workflow-read outage non-blocking (`BR-SLA-8`), dead-letter fallback (`BR-SLA-12`).
- `adapters/in-memory-reminder-ledger.test.ts` (5) — append-only + key isolation.
- `adapters/adapters.test.ts` (4) — pending query view + per-stage clock +
  terminal exclusion; scheduler manual tick.
- `http/sla-router.test.ts` (4) — 401 / 403 / 200 / 404 guarded-read contract.

## Files Modified

None. The unit is purely additive — no shipped file was edited (least coupling;
it consumes upstream units only through their existing public ports).

## Key Implementation Decisions

- **Timer, not events.** The unit fires on the *absence* of a transition
  (elapsed pending time), so it is driven by `SchedulerPort`, not the
  `EventPublisher` the notification unit subscribes to
  (`business-logic-model` Design Approach).
- **Idempotency via the ledger key, not locking.** `(requestId, stage, tier)`
  membership makes overlapping / retried / catch-up ticks safe with no
  distributed lock (`BR-SLA-6/6a`, `tech-stack-decisions` Concurrency).
- **The DECISION to fire is the idempotency fact.** A record is appended even on
  a `RECIPIENT_UNRESOLVED` / dead-letter outcome, so a permanently-unresolvable
  contact is not retried forever (`BR-SLA-6/7`).
- **PII discipline.** The scan works from pseudonymous ids; contact PII is
  resolved late at dispatch and never logged or written to the ledger; all
  outcome codes are PII-free (`BR-PII-1/2`, `BR-SLA-10 / BR-PII-4`).
- **Escalation target is injected.** `escalationContactResolver` lets the policy,
  not the code, decide the breach audience; it falls back to the pending actor so
  a breach notice still lands (`BR-SLA-5`, open question preserved).
- **Deferred prod bindings.** The concrete scheduler (cron / EventBridge) and the
  durable ledger store are isolated behind ports and deferred to
  infrastructure-design (`tech-stack-decisions`).

## Test Coverage Summary

- **49 new tests**, all passing; **250/250** total across the repo (33 files).
- `npm run typecheck` clean, `npm run lint` clean, `npx vitest run --coverage`
  exits 0 (project thresholds ≥ 80% line / 75% branch met).
- Unit file coverage: `sla-policy.ts`, `templates.ts`, `sla-router.ts` 100%;
  `sla-scan-service.ts` 100% lines / 92% branch; ledger 100%; adapters ≥ 94%.
  `index.ts` and `subscribe.ts` are excluded by the shipped coverage config
  (`index.ts` pattern; thin wiring) — same posture as the other units.

## Deviations From the Plan

- **Adapter tests consolidated.** Plan Step 9 listed a ledger test and implied
  per-adapter tests; the scheduler and pending-query adapter tests were combined
  into one `adapters/adapters.test.ts` for cohesion — same coverage, fewer files.
- **Test-seed fix during verification.** The workflow repository enforces
  optimistic concurrency (`BR-INV-3`), so a test seed must persist the v1
  aggregate before saving a transition (v2). Corrected in `adapters.test.ts`;
  no production-code change.

No other deviations. All plan steps completed and verified.
