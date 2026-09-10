# Vacation Request App — Business Logic Model — `unit-notifications`

Functional design for the **Notification** unit — the choreographed side-effect
that turns each vacation-request state change into an **email** and an **in-app**
notification for the people who need to know. This unit is a pure **event
consumer**: it never drives the workflow and is never on the synchronous command
path.

Scope is bound to the single story the [[unit-of-work-story-map]] assigns to
`unit-notifications`:

- `story-notifications` — Email and in-app notifications on state changes
  (covers `req-notifications-email-inapp`).

That requirement id and the "notify on every state change" shape are defined in
[[requirements]] (functional-requirements section). **SLA reminders and
escalation are explicitly out of scope here** — they are the separate
`unit-sla-escalation` unit (`req-sla-reminder-escalation`), which *depends on*
this unit; this unit provides the send capability, not the scheduling.

Per the [[unit-of-work]] `unit-notifications — Notification` definition, this
unit **depends on `unit-request-workflow`** (already completed) and consumes its
emitted domain events. The [[components]] architecture places the `notification`
component as an event subscriber (`notification` depends on
`vacation-request-workflow`), and the [[services]] artifact routes it on the
**choreography** side — a side-effecting consumer, not an orchestrated command.
The public method shapes are fixed by [[component-methods]] (`notification`
section) and are the contract this model elaborates.

## Design Approach

The unit is modelled as an **idempotent, at-least-once event handler** with two
independent **delivery channels** behind ports. It consumes the shipped
`WorkflowEvent` contract (`src/workflow/domain/events.ts`) through the
`EventPublisher` choreography seam (`src/workflow/ports/event-publisher.ts`) that
`unit-request-workflow` already ships — this unit **subscribes; it never calls
the workflow back**, preserving the least-coupling boundary the workflow unit
established (`business-logic-model` Outbound domain events).

The core pipeline for each consumed event is: **resolve recipients → build a
per-channel message from a template → dispatch to each channel independently →
record the outcome idempotently**. Each of the four steps is a guarded, pure-ish
stage; only the dispatch step performs I/O, and it does so through
`EmailSenderPort` and `InAppInboxPort` so the domain logic is unit-testable
without a live mail provider or store — the same hexagonal seam pattern already
shipped (`SessionStore`, `RoleDirectoryPort`, `EventPublisher`).

PII handling follows the invariant chain already established
(`req-nfr-security-pii`, workflow `BR-INV-6`, authz `BR-PII-*`): the **event bus
stays PII-free** — events carry only pseudonymous ids (`requestId`, `ownerId`,
`actorId`), `department`, `status`, and `atMs`. Recipient contact details (email,
display name) are resolved **at send time** from a read-only
`RecipientDirectoryPort` and are **never logged** (`redactForLog` at every
boundary). This keeps PII out of the choreography bus and out of the notification
unit's own durable state beyond what a delivery record strictly needs.

Error handling follows the shipped `Result<T, E>` convention
(`src/domain/result.ts`): expected failures (unresolvable recipient, transient
channel error) are returned as `Result.err` values carrying a machine-readable,
PII-free code — never thrown. Crucially, **a notification failure never blocks or
reverses the source transition**: by the time the event is published the workflow
commit has already happened (workflow `BR-INV-5` — event emitted in the same
logical commit as the state change). A failed send is retried with backoff and,
on exhaustion, dead-lettered for operability, not surfaced back to the workflow.

The unit exposes one primary capability plus supporting reads, matching
[[component-methods]] (`notification` section):

1. **Handle a workflow event** — the subscriber entry point (fan-out to
   channels).
2. **List / mark-read in-app notifications** — the reader side of the in-app
   channel for `req-notifications-email-inapp`.

## Notification Pipeline (per consumed event)

```
WorkflowEvent (from EventPublisher choreography bus, PII-free)
        │
        ▼
handleEvent(event):
  1. idempotency guard:
        derive dedupeKey = hash(event.requestId, event.type, event.atMs)
        if delivery already recorded for (recipient, dedupeKey) → skip that recipient  [at-least-once safe]
  2. resolve recipients (see business-rules BR-NOTIF-1..4):
        recipients = recipientPolicy(event)            // owner + next actor by event type
        for each recipientId → RecipientDirectoryPort.resolve(recipientId)
        unresolved recipient → record skipped(RECIPIENT_UNRESOLVED); continue  [non-fatal]
  3. render message per channel:
        template = templateFor(event.type)             // keyed by WorkflowEventType
        email  = renderEmail(template, event, recipientContact)
        inApp  = renderInApp(template, event)
  4. dispatch (independent per channel, graceful degradation):
        emailOutcome = EmailSenderPort.send(email)      // retryable
        inAppOutcome = InAppInboxPort.put(inApp)         // retryable
  5. record NotificationDelivery{ recipient, dedupeKey, channelOutcomes, atMs } (append-only)
  6. on any channel err after retries → dead-letter that (recipient, channel); never throw upstream
```

- The pipeline is **at-least-once**: the durable bus (SNS/EventBridge, decided at
  infrastructure-design) may redeliver an event. Step 1's dedupe key makes
  redelivery a no-op per recipient — the correctness guarantee is idempotency,
  not exactly-once (see `memory.md` tradeoff).
- The two channels are **independent**: an email-provider outage does not lose
  the in-app copy and vice-versa. Each channel's outcome is recorded separately
  so retry/dead-letter is per-channel (business-rules BR-NOTIF-7).

### Workflow N-A — Handle a state-change event (`handleEvent`)

Input: a `WorkflowEvent` (`RequestSubmitted` | `RequestValidated` |
`RequestApproved` | `RequestRejected` | `RequestWithdrawn`). Output:
`Result<NotificationBatchResult, NotificationError>` — the batch result reports
per-recipient/per-channel outcomes; it is *never* a workflow-blocking error.

```
handleEvent(event):
  1. map event.type → recipient set + template (BR-NOTIF-1..5)
  2. for each recipient (idempotent per step-1 dedupe):
        resolve contact; render email + in-app; dispatch both
        collect ChannelOutcome per channel
  3. persist NotificationDelivery records (append-only, BR-NOTIF-9)
  4. return ok(batchResult)   // partial failures are inside the result, not thrown
```

### Workflow N-B — Read the in-app inbox (`listForRecipient` / `markRead`)

Input: an `AuthenticatedPrincipal` (the viewer), optional `unreadOnly` filter /
a `NotificationId` to mark read. Output: `Result<InAppNotification[], …>` /
`Result<void, …>`.

```
listForRecipient(principal, unreadOnly?):
  1. authorize: a principal may read ONLY their own inbox (self-scope,
        mirrors authz BR-AUTHZ-7) → else forbidden
  2. return InAppInboxPort.list(principal.principalId, unreadOnly)

markRead(principal, notificationId):
  1. load notification; not found → err(notFound)
  2. self-scope guard: notification.recipientId == principal.principalId
        else → err(forbidden)                                   [fail closed]
  3. InAppInboxPort.markRead(notificationId)  → idempotent (already-read is ok)
```

Self-scoping reuses the authorization posture from `unit-platform-authz`
(`BR-AUTHZ-7` employee self-scope) rather than re-deriving it: the in-app inbox
is per-principal and a viewer sees only their own notifications.

## Data Flow & Integration Points

- **Inbound (choreography, from `unit-request-workflow`)**: this unit registers a
  subscriber on the shipped `EventPublisher` (`InMemoryEventPublisher.subscribe`
  in dev/test; a durable-bus subscription in production). It receives the exact
  `WorkflowEvent` union already defined — no new event contract is introduced
  here, and the workflow unit is unaware of this consumer (least coupling, per
  [[services]] choreography).
- **Recipient resolution (read-only)**: `RecipientDirectoryPort.resolve(principalId)`
  returns a PII-bearing `RecipientContact` (email, display name) used only to
  build the outbound message; it is never echoed to logs or to the bus. Its
  backing store (IdP / HRIS / internal directory) is an infrastructure decision
  (see `memory.md` open question).
- **Outbound channels (ports)**: `EmailSenderPort.send(EmailMessage)` and
  `InAppInboxPort.put(InAppNotification)` — independent adapters. The in-memory
  dev/test adapters record sent messages so tests assert the notify-per-event
  behaviour, exactly mirroring the `InMemoryEventPublisher` /
  in-memory-store pattern already in the tree.
- **To `unit-sla-escalation` (downstream, out of scope)**: the SLA unit reuses
  this unit's send capability (the same `EmailSenderPort` / `InAppInboxPort`
  seam) to deliver reminder/escalation notices on a timer. This unit exposes the
  send capability; it does not own the scheduling.
- **PII posture (`req-nfr-security-pii`)**: the bus and this unit's delivery
  records carry only pseudonymous ids and channel outcomes; contact PII lives
  transiently in the rendered message and is encrypted at rest if any message
  body is persisted (`CryptoPort`, mirroring authz `BR-PII-3`).

Persistence for the in-app inbox and delivery records is behind the
`InAppInboxPort` / delivery-record repository so the in-memory dev/test adapter
can be swapped for a durable store in production without changing the handler —
the same port/adapter seam the shipped units use (`SessionStore`,
`RoleDirectoryPort`, `BalanceCache`, `EventPublisher`).
