# Code Generation Plan — `unit-sla-escalation`

Timer-driven SLA reminder/escalation scanner for the vacation-request modular
monolith. Grounded in the unit's `business-logic-model`, `domain-entities`,
`business-rules`, `tech-stack-decisions`, and `logical-components`
functional/nfr-design artifacts, and the `unit-of-work` definition
(`unit-sla-escalation — SLA Reminder and Escalation`). Satisfies
`req-sla-reminder-escalation` via the single owned story
`story-sla-escalation`.

The unit **adds no new runtime, framework, or transport** (per
`tech-stack-decisions`): TypeScript 5.5 (strict) + Node 20 + ESM + Express 4
(only for an optional guarded debug read) + `Result<T, SlaError>`. It reuses
`unit-request-workflow` (read-only pending view) and `unit-notifications` (send
seam + directory) verbatim, by id, never mutating the workflow aggregate.

All source code lives under `src/sla-escalation/**` (mirrors the shipped
per-unit layout `src/workflow`, `src/notifications`). Vitest auto-globs
`src/**/*.test.ts`, so no new test config is needed
(`tech-stack-decisions` Tooling).

## Story → Code-Step Traceability

| Story | Requirement | Plan steps |
|-------|-------------|-----------|
| `story-sla-escalation` | `req-sla-reminder-escalation` | Steps 2–9 (domain, ports, evaluate, service, adapters, debug read, wiring, tests) |

Cross-cutting: `req-nfr-security-pii` (PII-free ledger + late contact
resolution) is realised in Steps 2, 3, 5, 6; idempotency (`BR-SLA-6/6a/7`) in
Steps 4, 5, 6, 9.

## Steps

- [ ] **Step 1: Project structure setup.** Create `src/sla-escalation/{domain,ports,services,adapters,http}`. No new package.json/config — adopt the shipped `tsconfig.json`, `vitest.config.ts`, `.eslintrc.cjs`. (`tech-stack-decisions`.)
- [ ] **Step 2: Domain value objects, errors, entity** (`business-rules` `BR-SLA-4/4a/9/10`, `domain-entities`).
  - `domain/value-objects.ts` — `SlaStage` (reuse `WorkflowStage`), `SlaTier` (`OnTrack|ReminderDue|EscalationDue` + fired tags `Reminder|Escalation`), `SlaThresholds` (`reminderAfterMs<escalateAfterMs`), `EscalationPolicy`, `SlaEvaluation`, `PendingRequestView`, `SlaOutcomeCode`.
  - `domain/errors.ts` — `SlaError` taxonomy (`MISCONFIGURED_POLICY | RECIPIENT_UNRESOLVED | CHANNEL_ERROR | WORKFLOW_READ_ERROR`), PII-free, mirrors `NotificationError`.
  - `domain/reminder-record.ts` — append-only `ReminderRecord` (`(requestId, stage, tier)` identity) + `reminderKey` helper.
- [ ] **Step 3: Ports (hexagonal seams)** (`domain-entities` Ports).
  - `ports/scheduler-port.ts` — `SchedulerPort.onTick(handler)`.
  - `ports/workflow-pending-query-port.ts` — read-only `listPending()` / `findById()` → `PendingRequestView`.
  - `ports/reminder-ledger-repository.ts` — append-only `hasFired()` / `record()`.
- [ ] **Step 4: Domain policy — pure `evaluate` + clock + policy validation + templates** (`business-logic-model` Workflow S-B, `business-rules` `BR-SLA-2/3/4/4a/9`).
  - `domain/sla-policy.ts` — `validatePolicy` (fail-closed monotonic, the one allowed throw), `pendingStageOf`, `elapsedMs` clock helper (wall-clock default; business-hours flag deferred), `classify`, `evaluate` (pure), `tiersUpTo` (catch-up).
  - `domain/templates.ts` — PII-free SLA reminder/escalation subject/body/title renderers.
- [ ] **Step 5: Business logic — `SlaScanService`** (`business-logic-model` Workflow S-A, `business-rules` `BR-SLA-1/5/6/6a/7/8/11/12`, `BR-PII-*`).
  - `services/sla-scan-service.ts` — `runScanTick(nowMs)` (enumerate → evaluate → catch-up dispatch due un-fired tiers → append ledger; returns `ok(ScanSummary)`, never blocking), `evaluate(view, nowMs)` re-export of the pure fn, recipient resolution + dispatch via the reused notification seam.
- [ ] **Step 6: Adapters (in-memory dev/test doubles)** (`tech-stack-decisions` Persistence/Scheduling).
  - `adapters/in-memory-reminder-ledger.ts` — append-only, `(requestId, stage, tier)` set.
  - `adapters/workflow-pending-query-adapter.ts` — wraps `VacationRequestRepository.findByDepartmentAndStatus` into `PendingRequestView` (read-only, PII-free).
  - `adapters/interval-scheduler.ts` — in-process `SchedulerPort` (setInterval / manual drive).
- [ ] **Step 7: API / debug endpoint layer** (optional guarded read, `logical-components` C9, `security-design` SEC-DES-4).
  - `http/sla-router.ts` — `GET /sla/requests/:requestId/evaluate`, guarded by `requireSession → requirePermission('request:view-department')`, returns PII-free `SlaEvaluation`.
- [ ] **Step 8: Business-logic tests** — `domain/sla-policy.test.ts` (pure `evaluate`/`classify`/`validatePolicy`/`tiersUpTo`, exhaustive), `domain/templates.test.ts`.
- [ ] **Step 9: Service + adapter + router tests** — `services/sla-scan-service.test.ts` (idempotency `BR-SLA-6`, catch-up `BR-SLA-6a`, terminal self-heal `BR-SLA-9`, recipient-unresolved, non-blocking `BR-SLA-8`), `adapters/in-memory-reminder-ledger.test.ts`, `http/sla-router.test.ts`.
- [ ] **Step 10: Public surface + wiring** — `index.ts` (public exports), `subscribe.ts` (`registerSlaScheduler` wiring helper binding a `SchedulerPort` to `runScanTick`).
- [ ] **Step 11: Test configuration** — none new required; Vitest root config auto-globs `src/sla-escalation/**/*.test.ts` (`tech-stack-decisions` Tooling). Verified by running the suite.
- [ ] **Step 12: Documentation** — inline TSDoc on every module (matching the shipped style); code-summary artifact recorded at stage end.

## Test Strategy

Per `tech-stack-decisions` (Vitest, coverage ≥ 80% line / 75% branch) and the
Standard test posture: unit test files per component (evaluate, templates,
service, ledger adapter) plus the router boundary test. The pure `evaluate`
core is exhaustively tested; scan-tick idempotency and catch-up are the
key behavioural cases (`BR-SLA-6/6a`).

## Verification

`npm run typecheck`, `npm run lint`, `npm test` all green before completion
(the `type-check` and `linter` sensors fire on each TS write).
