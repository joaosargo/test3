# Vacation Request App — Business Rules — `unit-notifications`

Decision rules, recipient policy, delivery invariants, and edge cases for the
**Notification** unit. Rules trace to `req-notifications-email-inapp` (from
[[requirements]]) via the single story the [[unit-of-work-story-map]] assigns to
this unit (`story-notifications`). Rule shapes align with the `notification`
signatures in [[component-methods]] and the subscriber boundary in [[components]]
(`notification → vacation-request-workflow`); the unit's placement on the
**choreography** side (not the synchronous command path) is per [[services]] and
the `unit-notifications — Notification` definition in [[unit-of-work]].

Convention: rule ids are stable — `BR-NOTIF-*` for delivery/recipient rules,
`BR-PII-*` for PII rules (extending the taxonomy shipped by `unit-platform-authz`
and `unit-request-workflow`). Every rule is **non-blocking with respect to the
workflow**: a notification failure is retried and dead-lettered, never propagated
back as a workflow error, because the source transition already committed
(workflow `BR-INV-5`).

## Recipient & Trigger Rules

The unit reacts to the five shipped `WorkflowEvent` types
(`src/workflow/domain/events.ts`). Each event maps to a recipient set and a
template.

| Event | Trigger meaning | Default recipients (BR-NOTIF-1..5) |
|-------|-----------------|------------------------------------|
| `RequestSubmitted` | Employee submitted; awaiting team lead | Owner (confirmation) **+ the team lead** (action needed) |
| `RequestValidated` | Team lead validated; awaiting HR | Owner (progress) **+ HR** (action needed) |
| `RequestApproved` | HR approved (terminal success) | Owner (outcome); approvers optional |
| `RequestRejected` | Rejected at lead or HR stage (terminal) | Owner (outcome, with stage); rejecting actor optional |
| `RequestWithdrawn` | Owner withdrew before lead acted (terminal) | Owner (confirmation); team lead optional |

- **BR-NOTIF-1 (Notify on every state change).** Exactly the five workflow
  transitions produce notifications — one handling pass per consumed event.
  Directly satisfies `req-notifications-email-inapp` ("notifications on state
  changes"). No transition is silently un-notified (pairs with workflow
  `BR-INV-5` event-per-transition).
- **BR-NOTIF-2 (Owner is always notified).** The request `ownerId` is a recipient
  of every event about their request. This is the one non-optional recipient.
- **BR-NOTIF-3 (Next-actor notification).** On `RequestSubmitted` the **team
  lead** is notified (their queue has work); on `RequestValidated` **HR** is
  notified. This turns the two-stage workflow into an actionable pipeline.
- **BR-NOTIF-4 (Recipient resolution is directory-driven, read-only).** A
  recipient `PrincipalId` (or a role-in-department, e.g. "the team lead of
  department X") is resolved to a `RecipientContact` via `RecipientDirectoryPort`.
  This unit never derives contact details or org structure itself. An
  unresolvable recipient is recorded `skipped(RECIPIENT_UNRESOLVED)` and does not
  fail the batch (BR-NOTIF-8).
- **BR-NOTIF-5 (Approver copies are optional / configurable).** Copies to the
  approving actor on terminal events (`Approved`/`Rejected`) default per the
  matrix above and are configurable; the owner copy is not (see `memory.md` open
  question). Absence of an optional recipient is never an error.
- **BR-NOTIF-6 (Both channels per recipient).** Each notified recipient gets an
  **email** and an **in-app** notification for the same event
  (`req-notifications-email-inapp` names both). A recipient with no email contact
  still receives the in-app copy (graceful degradation, BR-NOTIF-7).

## Delivery & Reliability Rules

- **BR-NOTIF-7 (Channels are independent).** Email and in-app dispatch are
  independent; one channel's failure does not abort the other. Outcomes are
  recorded per channel so retry/dead-letter is per-channel. This is the
  graceful-degradation posture — a mail-provider outage must not lose the in-app
  copy.
- **BR-NOTIF-8 (Non-fatal, non-blocking).** No notification outcome — success,
  skip, or failure — ever blocks or reverses the source transition. The workflow
  committed before publishing the event; this consumer runs after the fact
  (choreography, per [[services]]). Failures return inside the batch result, not
  as a thrown/blocking error.
- **BR-NOTIF-9 (Idempotent at-least-once).** Delivery is at-least-once (a durable
  bus may redeliver). A `dedupeKey = hash(requestId, eventType, atMs)` per
  recipient makes redelivery a no-op: if a `NotificationDelivery` already exists
  for `(recipientId, dedupeKey)`, that recipient is skipped. Exactly-once across
  email + a separate in-app store is not attempted (see `memory.md` tradeoff);
  idempotency is the correctness guarantee.
- **BR-NOTIF-10 (Retry with backoff, then dead-letter).** A transient channel
  error (provider 5xx/timeout) is retried with exponential backoff and jitter
  (bounded attempts). On exhaustion the `(recipient, channel)` is dead-lettered
  for operability — never retried forever, never lost silently.
- **BR-NOTIF-11 (Append-only delivery record).** Each handling pass appends
  `NotificationDelivery` records; records are never mutated (they are an
  operational fact trail, distinct from the compliance `audit-trail`). This makes
  the idempotency check and dead-letter reconciliation deterministic.
- **BR-NOTIF-12 (In-app self-scope).** A principal may list and mark-read only
  their **own** in-app notifications, reusing the `unit-platform-authz` self-scope
  posture (`BR-AUTHZ-7`). Cross-principal inbox access is `forbidden`. `markRead`
  is idempotent (marking an already-read notification is a no-op success).

## PII Protection Rules

- **BR-PII-1 (Bus stays PII-free).** The consumed `WorkflowEvent` carries only
  pseudonymous ids (`requestId`, `ownerId`, `actorId`), `department`, `status`,
  and `atMs` — never email or free-text reason (upstream workflow `BR-INV-6`).
  This unit relies on that and adds no PII to any event it observes.
- **BR-PII-2 (Contact PII is resolved late and never logged).** `RecipientContact`
  (email, display name) exists only transiently while building the outbound
  message. It MUST NOT appear in logs, error messages, `cause`, or delivery
  records — `redactForLog` at every serialization boundary, extending the shipped
  `BR-PII-2` invariant.
- **BR-PII-3 (Encrypt persisted message bodies at rest).** If a rendered message
  body (which embeds contact PII / reason context) is persisted — e.g. the in-app
  notification text — it is stored via `CryptoPort` field-level encryption;
  plaintext PII is never written to durable storage (`req-nfr-security-pii`,
  mirroring authz `BR-PII-3`). A `CryptoPort`-unavailable write fails closed.
- **BR-PII-4 (No PII in machine codes).** All `NotificationError` codes and
  skip/outcome reasons are machine-readable and PII-free
  (`RECIPIENT_UNRESOLVED`, `CHANNEL_TRANSIENT`, `CHANNEL_DEAD_LETTERED`).

## Validation & Edge Cases

- **Unknown / unmapped event type** → the handler ignores it (no recipients, no
  send); logged as an advisory no-op. Only the five known `WorkflowEvent` types
  produce notifications (fail-closed on the recipient policy).
- **Recipient with no email but a valid in-app identity** → in-app delivered,
  email recorded `skipped(NO_EMAIL_CONTACT)`; batch still succeeds (BR-NOTIF-6/7).
- **Duplicate event delivery (bus redelivery)** → deduped per recipient via the
  dedupe key; no duplicate email/in-app (BR-NOTIF-9).
- **Email provider transient failure** → retried with backoff; in-app copy
  unaffected (BR-NOTIF-7/10).
- **Email provider persistent failure** → dead-lettered after bounded retries;
  the state change is unaffected and the in-app copy still lands (BR-NOTIF-8/10).
- **A principal requests another principal's inbox** → `forbidden` (self-scope,
  BR-NOTIF-12); no notifications leaked.
- **mark-read on an already-read or unknown notification** → already-read is an
  idempotent success; unknown id is `notFound` (BR-NOTIF-12).
- **Out of scope — SLA reminders/escalation.** Timed reminders and escalation on
  breach are `unit-sla-escalation` (`req-sla-reminder-escalation`), not this unit;
  no timer/scheduler logic lives here.
