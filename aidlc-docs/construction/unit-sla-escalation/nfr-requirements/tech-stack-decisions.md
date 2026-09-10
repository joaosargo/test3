# Tech-Stack Decisions — `unit-sla-escalation`

Technology selections and rationale for the **SLA Reminder and Escalation**
unit. The dominant constraint is **consistency with the already-shipped modular
monolith**: `unit-platform-auth`, `unit-platform-authz`, `unit-hris-balance`,
`unit-request-workflow`, and `unit-notifications` are in the tree with a fixed
TypeScript/Node/Express stack and a hexagonal layout, and this unit consumes
their public surfaces read-only ([[business-logic-model]] Data Flow;
[[domain-entities]] Design note). Decisions therefore overwhelmingly **adopt**
the established stack and add **no new runtime, framework, or transport** — the
least-coupling, design-for-change posture in the architecture guidance and the
team `## Way of Working` / `## Code Style` rules. Choices trace to the
timer-driven scanner shape in [[business-logic-model]], the idempotency and
PII invariants in [[business-rules]] (`BR-SLA-6/7`, `BR-PII-*`), and the
constraints in [[requirements]] (`req-sla-reminder-escalation`,
`req-nfr-security-pii`, `req-constraint-build-gate`).

## Language, Runtime & Framework

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Language | **TypeScript 5.5** (strict) | Matches the shipped units; static types make the `SlaTier` classification and `Result<T, SlaError>` errors compile-checked ([[domain-entities]]). |
| Runtime | **Node.js ≥ 20** | Fixed by `package.json` `engines`; shared across all units. |
| Module system | **ESM** with `.js` import specifiers | Mirrors the shipped ESM import convention. |
| HTTP framework | **Express 4** (only if a debug/status read is exposed) | The unit has no primary HTTP surface; a single optional guarded debug read (`evaluate` for one request) composes on the existing Express + `requireSession → requirePermission` seam. No standalone server. |
| Error model | **`Result<T, SlaError>`** (no throwing for expected failures) | Reuses `src/domain/result.ts`; mirrors the `SsoError` / `AuthzError` / `WorkflowError` / `NotificationError` taxonomy ([[business-logic-model]] Error handling, [[business-rules]] `BR-SLA-8`). The one allowed throw is `MISCONFIGURED_POLICY` at load ([[business-rules]] `BR-SLA-4a`). |

**Decision — adopt the shipped stack; add no new language, framework, or
message transport.** Introducing a different runtime or a dedicated queue/broker
for one background scanner in a modular monolith would fragment the build,
duplicate the hexagonal seams, and re-implement the delivery reliability the
notification unit already owns — a net increase in coupling for no benefit.
Rejected alternatives: a separate scheduler microservice in another language
(premature split — the units-generation topology keeps this an in-process unit);
a new message-broker-driven design (the unit fires on the *absence* of an event —
elapsed time — which no broker message can signal, so an event-driven transport
would not even fit the problem; see [[business-logic-model]] Inbound and the
functional-design memory).

## Scheduling & Concurrency

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Trigger model | **Timer-driven scanner behind a `SchedulerPort`** | The unit fires on elapsed pending time, not on an event ([[business-logic-model]] Design Approach). The port abstracts the timer so dev/test drive ticks manually and prod wires a cron / cloud scheduler. |
| Dev/test scheduler | **In-process interval / manual `runScanTick(nowMs)` call** | Deterministic, fast tests with an injected clock — the same injected-clock discipline the workflow/notification units use ([[business-rules]] `BR-SLA-3`). |
| Production scheduler | **Cron / EventBridge Scheduler (decided at infrastructure-design)** | Deferred deliberately — the `SchedulerPort` isolates the choice ([[domain-entities]]); functional design fixes only the port shape (memory open question). |
| Concurrency safety | **Idempotent ledger key, not locking** | Overlapping/retried/double-covering ticks are safe via the `(requestId, stage, tier)` dedupe key ([[business-rules]] `BR-SLA-6`); no distributed lock or leader election required at MVP scale ([[scalability-requirements]]). |
| Clock | **Injected clock, wall-clock default; business-hours as a policy flag** | `clock.elapsed(enteredAtMs, nowMs, policy.businessHours?)` ([[business-rules]] `BR-SLA-3`); business-hours-awareness deferred as an open question (memory). |

**Decision — defer the concrete production scheduler binding to
infrastructure-design; commit only to the `SchedulerPort` contract now.** This
keeps the reversible decision reversible (architecture guidance: "reversibility
over perfection") and honours the `req-constraint-build-gate` procurement gate —
no scheduler product is procured at design time.

## Persistence — the Reminder Ledger

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Persistence contract | **`ReminderLedgerRepository` port** (append-only) | DDD repository rule, one per aggregate root; `hasFired` + `record` only — no update/delete ([[domain-entities]]; [[business-rules]] `BR-SLA-7`). |
| Store semantics | **Append-only, keyed by `(requestId, stage, tier)`** | The idempotency guarantee (`BR-SLA-6`) and the SLA-decision fact trail; distinct from the compliance `audit-trail` and the notification `NotificationDelivery` record ([[business-logic-model]] Own durable state). |
| Dev/test adapter | **In-memory** implementation | Mirrors shipped `InMemorySessionStore` / `InMemoryRoleDirectory` / `NotificationDeliveryRepository`; fast deterministic tests. |
| Production adapter | **Durable append-only store (decided at infrastructure-design)** | Deferred — the port isolates the choice; a key-value / document store keyed by the composite idempotency key fits the single-key `hasFired` read + append write pattern. |
| Retention | **Operational horizon, not the 7-year audit window** | The ledger is operational, not compliance evidence ([[scalability-requirements]], [[reliability-requirements]]); `req-nfr-audit-retention` governs `unit-audit-trail`, not this ledger. |

**Decision — commit to the append-only ledger port contract now; defer the
concrete store to infrastructure-design.** Same reversible, procurement-gated
posture as the workflow unit's store decision.

## Integration & Cross-Unit Contracts

- **Pending-request read** — consume `unit-request-workflow` through a read-only
  `WorkflowPendingQueryPort` (`listPending` / `findById`) returning the narrowed
  PII-free `PendingRequestView`; **never** the mutating `VacationRequest`
  aggregate ([[business-logic-model]] Pending-request read; [[business-rules]]
  `BR-SLA-1`). Maps onto the workflow repository's existing
  `findByDepartmentAndStatus` scoped read.
- **Delivery** — reuse `unit-notifications`' `EmailSenderPort`,
  `InAppInboxPort`, and `RecipientDirectoryPort` **verbatim**; build
  SLA-flavoured messages from this unit's own templates but hand them to the
  **same** transport seam, inheriting its retry/dead-letter reliability
  ([[business-rules]] `BR-SLA-12`; notifications `BR-NOTIF-7/10`). No new
  email/in-app transport is introduced.
- **Identity & request value objects** — reuse `PrincipalId`, `RequestId`,
  `RequestStatus`, `WorkflowStage`, `Transition`, `DepartmentCode` read-only from
  the upstream units ([[domain-entities]] Design note); do not redefine. Cross-unit
  references are **by id, not object graph** (least coupling).
- **Escalation target** — modelled as an injected `escalationContactResolver`
  over the notifications directory ([[business-rules]] `BR-SLA-5`) so the policy,
  not the code, decides the concrete target (open question — memory).

## Tooling, Testing & Conventions

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Build | **`tsc`** (`npm run build` / `typecheck`) | Existing scripts; no bundler for a server-side background unit. |
| Test runner | **Vitest** | Shipped test tool; root `vitest.config.ts` auto-globs `src/**/*.test.ts`, so `src/sla-escalation/**` tests are picked up with no new config (workflow/authz precedent). |
| Lint | **ESLint** + `@typescript-eslint` | Existing `.eslintrc.cjs`; team `## Code Style` defers to project linter. |
| Coverage | **`@vitest/coverage-v8`**, project ≥ 80% line / 75% branch | Existing thresholds; the pure `evaluate` function is exhaustively tested plus scan-tick idempotency (`BR-SLA-6`) and catch-up (`BR-SLA-6a`) cases. |
| Secrets | **Env / secrets manager**, never hard-coded | Team `## Security` rule; `ADR-AUTH-04` precedent; applies to ledger, scheduler, and transport credentials. |
| PII handling | **Pseudonymous-ids-only; `redactForLog`; PII-free codes** | [[business-rules]] `BR-PII-1/2`, `BR-SLA-10 / BR-PII-4`; `req-nfr-security-pii`. |

## Summary of Decisions

1. **Adopt** TypeScript + Node 20 + ESM + `Result<T,E>` (+ Express only for an
   optional guarded debug read) — no new language, framework, or transport.
2. **Timer-driven scanner** behind a `SchedulerPort`; in-process/manual ticks in
   dev/test, cron / cloud scheduler in prod (deferred to infrastructure-design).
3. **Idempotency via the append-only `(requestId, stage, tier)` ledger key**, not
   locking or leader election — overlapping ticks are safe.
4. **In-memory** dev/test ledger now; **durable append-only** production store
   decided at infrastructure-design (reversible, procurement-gated), on an
   **operational** (not 7-year audit) retention horizon.
5. **Consume** `unit-request-workflow` (read-only pending view) and
   `unit-notifications` (send seam + directory) surfaces verbatim; references
   **by id**; no re-implemented delivery.
6. **Vitest + ESLint + tsc**, coverage thresholds and PII/secret rules inherited
   from the shipped project and team practices.
