# Security Design — `unit-sla-escalation`

Concrete security architecture for the **SLA Reminder and Escalation** unit —
the least-privilege principal, read-only boundary enforcement, PII containment,
encryption, secrets, and integrity decisions that satisfy this unit's
`security-requirements` (SEC-SLA-1..12). It is grounded in the PII-late-resolution
posture and read-only integration seams in `business-logic-model` (PII posture,
Data Flow), the append-only idempotent ledger and no-new-transport choices in
`tech-stack-decisions` (Persistence, Integration, Tooling — Secrets/PII rows),
and the load/durability envelope in `scalability-requirements`,
`performance-requirements`, and `reliability-requirements`.

The governing security property, restated from `security-requirements`: this
unit is a **timer-driven, non-interactive side-effect** with **no user-facing
command endpoint and no user authentication**. Its security surface is
concentrated on **PII discipline over the data it observes and the notices it
sends** and on **safe, read-only consumption of upstream boundaries** — not on
authentication or authorization policy, which it neither establishes nor owns.
It applies defense-in-depth by *removing* privilege (read-only, no mutating
grant) rather than by adding guards.

## Authentication & Authorization Architecture

- **SEC-DES-1 — Trusted background actor, no user login (SEC-SLA-1).** The unit
  runs on a scheduler (`SchedulerPort`, `business-logic-model` Data Flow), not
  behind an HTTP session. It authenticates no user and issues no user-scoped
  command. It executes as a **least-privilege service principal** whose *only*
  grants are: read the pending-request query view, read the recipient directory,
  send via the notification seam, and read/append the reminder ledger — nothing
  that can mutate business state.
- **SEC-DES-2 — Read-only over the workflow aggregate (SEC-SLA-2).** The unit
  consumes the narrowed `WorkflowPendingQueryPort` (`listPending` / `findById`)
  and MUST NEVER hold or invoke the mutating `VacationRequest` aggregate API
  (`BR-SLA-1`). Architecturally this is enforced by *what is injected*: the
  composition root wires only the query port into the scanner, so there is no
  code path — not even a mistaken one — through which the scanner can approve,
  reject, or advance a request. This removes any privilege-escalation path
  through the SLA unit.
- **SEC-DES-3 — Recipient resolution is read-only and role-scoped by the shared
  directory (SEC-SLA-3).** Escalation targets are resolved via the notifications
  `RecipientDirectoryPort.resolveActor(department, role)`; the SLA unit does not
  itself derive who may receive a notice — it reuses the same resolution the
  notification unit uses. The concrete escalation target (pending actor's manager
  / HR-ops mailbox) is an **injected `escalationContactResolver`** so widening
  the audience is a reviewed config change, never a code branch.
- **SEC-DES-4 — Optional debug read inherits the platform guard.** Per
  `tech-stack-decisions` the unit has no primary HTTP surface; the single optional
  debug/status read (`evaluate` for one request) composes on the *existing*
  Express `requireSession → requirePermission` seam owned by `unit-platform-auth`
  / `unit-platform-authz`. It exposes only PII-free evaluation output (stage,
  elapsedMs, tier, thresholds) — never contact details — and never a mutating
  operation.
- **SEC-DES-5 — No override, no state effect (SEC-SLA-4).** No scan outcome —
  reminder, escalation, skip, or failure — ever blocks, reverses, or drives a
  workflow transition (`BR-SLA-8`). A reminder is advisory pressure only and
  cannot be weaponised to force a decision; this complements the workflow unit's
  no-override guarantee (`req-hr-approve-reject-no-override`).

## Data Protection & PII Design

PII containment is the primary security concern; the design keeps PII out of
every durable/observable surface this unit owns.

| Surface | PII posture | Mechanism |
|---------|-------------|-----------|
| `PendingRequestView` (input) | **Pseudonymous ids only** — `requestId`, `ownerId`, `department`, `status`, transition timestamps | The narrowed view carries no email/name/reason; the unit never receives the `VacationRequest` object graph (SEC-SLA-5). |
| Reminder ledger (`ReminderRecord`) | **PII-free by construction** — `requestId`, `stage`, `tier`, `SlaOutcomeCode`, `firedAtMs` only | No contact details, names, or reasons ever written (SEC-SLA-6; mirrors notifications `BR-PII-4`, audit `BR-AUD-8`). |
| Contact PII (email, display name) | **Resolved late, transient, never persisted or logged** | Exists only in-memory while building the outbound SLA message; `redactForLog` at every boundary (SEC-SLA-7). |
| `SlaError` codes | **PII-free machine-readable taxonomy** | `MISCONFIGURED_POLICY` / `RECIPIENT_UNRESOLVED` / `CHANNEL_ERROR` / `WORKFLOW_READ_ERROR` returned inside `Result<T, SlaError>`; errors never leak subject identity (SEC-SLA-8). |
| Logs & error `cause` | **Redacted** | `redactForLog` applied at every log/error boundary; contact PII is structurally absent from the ledger and codes, so the log surface has nothing to leak. |

- **SEC-DES-6 — Ledger cannot become a shadow PII store.** Because
  `ReminderRecord` is defined to hold only ids/stage/tier/outcome/timestamp, there
  is no field into which PII could be written — PII-free is a *type-level*
  guarantee, not a runtime discipline (SEC-SLA-6).
- **SEC-DES-7 — Encryption in transit and at rest (SEC-SLA-9).** All calls to the
  workflow query port, the recipient directory, and the notification transport
  occur over TLS in production; the durable reminder-ledger adapter encrypts at
  rest. Because the ledger is PII-free (SEC-DES-6) at-rest exposure is minimal,
  but the operational trail is still protected consistent with the shipped chain.
  The in-memory dev/test ledger is non-persistent and out of scope for at-rest
  encryption.
- **SEC-DES-8 — No secrets in code (SEC-SLA-10).** Any credentials the durable
  ledger, the scheduler, or the notification transport need are injected from the
  environment or a secrets manager — never hard-coded — consistent with the
  shipped `ADR-AUTH-04` convention and the team `## Security` rule
  (`tech-stack-decisions` Tooling — Secrets).

## Integrity & Auditability Design

- **SEC-DES-9 — Append-only, at-most-once decision trail (SEC-SLA-11).** The
  reminder ledger is append-only; no `ReminderRecord` is mutated or deleted
  (`BR-SLA-7`). The composite `(requestId, stage, tier)` key simultaneously
  enforces at-most-once dispatch (`BR-SLA-6`) and yields a tamper-evident
  operational record of every SLA decision. This ledger is **distinct from** the
  compliance `audit-trail` (owned by `unit-audit-trail`) and from the notification
  unit's `NotificationDelivery` record — it captures *SLA decisions*, not raw
  sends.
- **SEC-DES-10 — Fail-closed on misconfiguration (SEC-SLA-12).** A non-monotonic
  or incomplete `EscalationPolicy` fails at load with the single allowed
  `MISCONFIGURED_POLICY` throw (`BR-SLA-4a`) rather than scanning with a broken
  policy — the unit never silently fires (or silently fails to fire) under a
  corrupt policy. This is the one place the unit fails *loud and closed*.

## Threat Model & Mitigations

| Threat | Vector | Mitigation (design) |
|--------|--------|---------------------|
| **Notification spam / harassment** | Double-fired or retried tick floods a recipient | Bounded structurally by the ledger: each tier fires at most once per `(requestId, stage, tier)` (`BR-SLA-6`); idempotent ticks cannot flood (SEC-DES-9). |
| **PII leakage via content or logs** | Contact details written to ledger/logs | Work from pseudonymous ids; resolve contact late/transiently; `redactForLog` at boundaries; PII-free codes (SEC-DES-6/7). |
| **Privilege escalation through the scanner** | Scanner mutates business state | Foreclosed by injection: only read-only workflow/directory ports + send capability are wired; no mutating grant exists (SEC-DES-1/2/5). |
| **Recipient mis-targeting** | Escalation sent to wrong person | Resolve through the shared directory port; escalation target is injected reviewed policy; unresolvable target → `RECIPIENT_UNRESOLVED`, batch continues, never guesses a fallback (SEC-DES-3; `BR-SLA-5`). |
| **Replay / forged scheduler trigger** | Spurious extra tick | Harmless: ledger dedupe makes ticks idempotent (`BR-SLA-6`) and the unit mutates no business state (SEC-DES-5); the scheduler principal is least-privilege (SEC-DES-1). |
| **Misconfigured policy fires wrongly** | Corrupt thresholds under-/over-fire | Fail-closed at load (`MISCONFIGURED_POLICY`), never scans with a broken policy (SEC-DES-10). |

## Security Verification

- **Read-only-boundary test**: assert the scanner's injected dependencies expose
  no mutating workflow operation; a static/compile check that only
  `WorkflowPendingQueryPort` (not the aggregate) is importable in the scan module.
- **PII-free-ledger test**: append records across all outcome codes and assert
  every persisted `ReminderRecord` contains only ids/stage/tier/outcome/timestamp
  — no email/name/reason field is populated (SEC-DES-6).
- **Redaction test**: force `RECIPIENT_UNRESOLVED` / `CHANNEL_ERROR` and assert no
  contact PII appears in the returned `SlaError`, the log line, or the error
  `cause` (SEC-DES-7/8).
- **Idempotency / anti-spam test**: run two ticks over the same due state; assert
  the second dispatches nothing and appends nothing (SEC-DES-9, `BR-SLA-6`).
- **Fail-closed test**: load a non-monotonic policy; assert `MISCONFIGURED_POLICY`
  throws at load and no tick runs (SEC-DES-10, `BR-SLA-4a`).

## Open Items (carried to infrastructure-design)

- Confirm the least-privilege **service-principal grants** and how the scheduler
  principal is provisioned (cron identity / EventBridge Scheduler role) at
  infrastructure-design.
- Confirm the durable ledger's **at-rest encryption** binding and secrets source
  jointly with infrastructure-design (`ADR-AUTH-04` precedent).
- Confirm the concrete **escalation-target policy** (`escalationContactResolver`
  configuration) with product/HR so audience widening stays a reviewed config
  change (SEC-DES-3 open question).
