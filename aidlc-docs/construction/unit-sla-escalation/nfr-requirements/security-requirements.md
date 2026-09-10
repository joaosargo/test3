# Security Requirements — `unit-sla-escalation`

Security NFRs for the **SLA Reminder and Escalation** unit. This unit is a
**timer-driven, non-interactive side-effect** — it exposes no user-facing
command endpoint and authenticates no user. It reads pending requests read-only
from `unit-request-workflow`, resolves recipients read-only through the
`unit-notifications` directory, and dispatches on the shipped notification
transport. Its security surface is therefore concentrated on **PII discipline
over the data it observes and the notices it sends**, and on **safe consumption
of upstream boundaries** — not on authentication or authorization policy (which
it neither establishes nor owns). Requirements trace to the PII invariants in
[[business-rules]] (`BR-PII-1`, `BR-PII-2`, `BR-SLA-10 / BR-PII-4`), the
PII-late-resolution posture in [[business-logic-model]] (PII posture), and
[[requirements]] `req-nfr-security-pii`.

## Authentication & Authorization

- **SEC-SLA-1 — No user authentication; a trusted background actor.** The unit
  runs on a scheduler (`SchedulerPort`, [[business-logic-model]] Data Flow), not
  behind an HTTP session. It has no interactive login and issues no user-scoped
  command. It must run as a **least-privilege service principal** whose only
  grants are: read the pending-request query view, read the recipient directory,
  and send via the notification seam — nothing that can mutate business state.
- **SEC-SLA-2 — Read-only over the workflow aggregate.** The unit consumes the
  narrowed `WorkflowPendingQueryPort` (`listPending` / `findById`) and MUST NEVER
  hold or invoke the mutating `VacationRequest` aggregate API ([[business-rules]]
  `BR-SLA-1`; [[business-logic-model]] Pending-request read). It cannot approve,
  reject, or advance a request — it only observes elapsed time and nudges. This
  preserves the boundary `unit-request-workflow` established and removes any
  privilege-escalation path through the SLA unit.
- **SEC-SLA-3 — Recipient resolution is read-only and role-scoped by the
  directory.** Escalation targets are resolved via the notifications
  `RecipientDirectoryPort.resolveActor(department, role)` ([[business-rules]]
  `BR-SLA-5`); the SLA unit does not itself derive who may receive a notice — it
  asks the shared directory, reusing the same resolution the notification unit
  uses. The concrete escalation target (pending actor's manager / HR-ops mailbox)
  is an injected `escalationContactResolver` (policy decides, not code — memory
  open question), so widening the audience is a config change reviewed as such,
  never a code branch.
- **SEC-SLA-4 — No override, no state effect.** No scan outcome — reminder,
  escalation, skip, or failure — ever blocks, reverses, or drives a workflow
  transition ([[business-rules]] `BR-SLA-8`). A reminder cannot be weaponised to
  force a decision; it is advisory pressure only. This complements the workflow
  unit's no-override guarantee (`req-hr-approve-reject-no-override`).

## Data Protection & PII

- **SEC-SLA-5 — Scan works from pseudonymous ids only.** The `PendingRequestView`
  carries only `requestId`, `ownerId`, `department`, `status`, and transition
  timestamps — no email, name, or free-text reason ([[business-rules]]
  `BR-PII-1`; [[domain-entities]] `PendingRequestView`). The unit adds no PII to
  any request it observes and never receives the `VacationRequest` object graph.
- **SEC-SLA-6 — The reminder ledger is PII-free by construction.** `ReminderRecord`
  stores only `requestId`, `stage`, `tier`, a PII-free `SlaOutcomeCode`
  (`DISPATCHED` / `RECIPIENT_UNRESOLVED` / `CHANNEL_DEAD_LETTERED`), and
  `firedAtMs` — never contact details, names, or reasons ([[business-rules]]
  `BR-SLA-10 / BR-PII-4`; [[domain-entities]] `ReminderRecord`). This mirrors the
  notifications `BR-PII-4` and audit `BR-AUD-8` posture already shipped.
- **SEC-SLA-7 — Contact PII resolved late, never logged.** Recipient/escalation
  contact (email, display name) exists only transiently while building the
  outbound SLA message via the notifications directory port; it MUST NOT appear
  in logs, error `cause`, or the ledger — `redactForLog` at every boundary
  ([[business-rules]] `BR-PII-2`; [[business-logic-model]] PII posture). Extends
  the notifications `BR-PII-2` rule.
- **SEC-SLA-8 — PII-free error taxonomy.** `SlaError` codes
  (`MISCONFIGURED_POLICY` / `RECIPIENT_UNRESOLVED` / `CHANNEL_ERROR` /
  `WORKFLOW_READ_ERROR`, [[domain-entities]] `SlaError`) are machine-readable and
  PII-free, returned inside `Result<T, SlaError>` — errors never leak the subject
  employee's identity or contact (`req-nfr-security-pii`).
- **SEC-SLA-9 — Encryption in transit and at rest.** All calls to the workflow
  query port, the recipient directory, and the notification transport occur over
  encrypted transport (TLS) in production; the durable reminder-ledger adapter
  encrypts at rest (`req-nfr-security-pii`). Because the ledger is PII-free by
  construction (`SEC-SLA-6`) the at-rest exposure is minimal, but the operational
  trail is still protected consistent with the shipped chain. The in-memory
  dev/test ledger is non-persistent and out of scope for at-rest encryption.
- **SEC-SLA-10 — No secrets in code.** Any credentials the durable ledger, the
  scheduler, or the notification transport need are injected from the environment
  or a secrets manager, never hard-coded — consistent with the shipped
  `ADR-AUTH-04` convention and the team `## Security` rule.

## Integrity & Auditability

- **SEC-SLA-11 — Append-only, at-most-once decision trail.** The reminder ledger
  is append-only; no `ReminderRecord` is mutated or deleted ([[business-rules]]
  `BR-SLA-7`). The composite `(requestId, stage, tier)` key both enforces
  at-most-once dispatch (`BR-SLA-6`) and yields a tamper-evident operational
  record of every SLA decision. This ledger is **distinct from** the compliance
  `audit-trail` (owned by `unit-audit-trail`) and from the notification unit's
  `NotificationDelivery` record — it captures *SLA decisions*, not raw sends
  ([[business-logic-model]] Own durable state).
- **SEC-SLA-12 — Fail-closed on misconfiguration.** A non-monotonic or
  incomplete `EscalationPolicy` fails at load with the one allowed
  `MISCONFIGURED_POLICY` throw ([[business-rules]] `BR-SLA-4a`) rather than
  scanning with a broken policy — the unit never silently fires (or silently
  fails to fire) under a corrupt policy.

## Threat Considerations

- **Notification spam / harassment vector** → bounded structurally by the ledger:
  each tier fires at most once per `(requestId, stage, tier)` (`BR-SLA-6`), so a
  double-fired or retried tick cannot flood a recipient (`SEC-SLA-11`).
- **PII leakage via reminder content or logs** → prevented by working from
  pseudonymous ids, resolving contact late, and redacting at log boundaries
  (`SEC-SLA-5/6/7`); the ledger cannot become a shadow PII store by construction.
- **Privilege escalation through the scanner** → foreclosed: the unit has only
  read-only workflow/directory access and a send capability, no mutating grant
  (`SEC-SLA-1/2/4`).
- **Recipient mis-targeting (sending an escalation to the wrong person)** →
  contained by resolving through the shared directory port and modelling the
  escalation target as injected policy (`SEC-SLA-3`); an unresolvable target is
  recorded `RECIPIENT_UNRESOLVED` and the batch continues, never guessing a
  fallback recipient ([[business-rules]] `BR-SLA-5`, Validation & Edge Cases).
- **Replay / forged scheduler trigger** → a spurious extra tick is harmless: the
  ledger dedupe makes ticks idempotent (`BR-SLA-6`), and the unit mutates no
  business state (`SEC-SLA-4`); the scheduler principal is least-privilege
  (`SEC-SLA-1`).
