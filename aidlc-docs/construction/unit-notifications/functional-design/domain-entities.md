# Vacation Request App — Domain Entities — `unit-notifications`

Entities, value objects, ports, and relationships for the **Notification** unit.
Grounded in the `notification` signatures of [[component-methods]], the
subscriber boundary in [[components]] (`notification → vacation-request-workflow`),
and the `unit-notifications — Notification` definition in [[unit-of-work]]. The
single owned story in [[unit-of-work-story-map]] (`story-notifications`) and its
requirement (`req-notifications-email-inapp` from [[requirements]]) drive the
attributes below. The unit sits on the **choreography** (side-effect) side per
[[services]], consuming events from the command-path `unit-request-workflow`.

Design note: identity, authorization, and the workflow event contract are **not
redefined** here. This unit consumes read-only:

- `PrincipalId` / `AuthenticatedPrincipal` from `unit-platform-auth`
  (`src/domain/entities.ts`),
- the `WorkflowEvent` union and its `WorkflowEventType`, `RequestId`,
  `DepartmentCode`, `RequestStatus`, `WorkflowStage` value objects from
  `unit-request-workflow` (`src/workflow/domain/events.ts`,
  `src/workflow/domain/value-objects.ts`),
- the `EventPublisher` choreography seam
  (`src/workflow/ports/event-publisher.ts`).

It adds only the notification-side value objects, the in-app notification entity,
and the delivery record — concepts no other unit models. Cross-unit references
use **ids, not object graphs** (least coupling), matching the boundary the
workflow and authz units established.

## Value Objects

All value objects are immutable; equality is by attribute value (DDD value-object
semantics), consistent with the shipped `LeaveBalance` / `Session` / `DateRange`
style.

### `NotificationId`
- Opaque, unique identifier of an in-app notification (e.g. UUID string).
- Prefer over a bare `string` (value-object-over-primitive heuristic, as with
  `PrincipalId` / `RequestId` upstream).

### `NotificationChannel` (enum-like)
- Members: `Email`, `InApp`. Tags which delivery channel a message/outcome
  belongs to (`req-notifications-email-inapp` names both).

### `DedupeKey`
- Deterministic idempotency token = `hash(requestId, eventType, atMs)`
  (business-rules `BR-NOTIF-9`). Two deliveries of the same event to the same
  recipient share a `DedupeKey`, so redelivery is a no-op.

### `RecipientContact` (PII-bearing, transient)
- `principalId`: `PrincipalId` (pseudonymous key).
- `email?`: subject email — **PII**; used only to build the outbound message,
  never logged (`BR-PII-2`).
- `displayName?`: **PII**; same handling.
- Resolved on demand by `RecipientDirectoryPort`; not persisted beyond an
  encrypted message body if any (`BR-PII-3`).

### `NotificationTemplate`
- Keyed by `WorkflowEventType`; renders a channel-specific subject/body from the
  PII-free event fields plus the resolved contact. Single default locale for MVP
  (localization deferred — see `memory.md` open question).

### `EmailMessage`
- `to`: recipient email (from `RecipientContact`), `subject`, `body`,
  `dedupeKey`. The payload handed to `EmailSenderPort`.

### `ChannelOutcome`
- `channel`: `NotificationChannel`.
- `status`: `Delivered` | `Skipped` | `DeadLettered`.
- `reason?`: PII-free machine code (`RECIPIENT_UNRESOLVED`, `NO_EMAIL_CONTACT`,
  `CHANNEL_TRANSIENT`, `CHANNEL_DEAD_LETTERED`).

### `NotificationError` (value-level failure)
- `code`: `NOT_FOUND` | `FORBIDDEN` | `RECIPIENT_UNRESOLVED` | `CHANNEL_ERROR`.
- PII-free message. Mirrors the `SsoError` / `AuthzError` / `WorkflowError`
  taxonomy convention already shipped; returned inside `Result<T,
  NotificationError>` per the existing `result.ts` convention, **not thrown**
  (throwing reserved for misconfiguration).

## Entities & Aggregates

### `InAppNotification` (entity — the in-app channel record)

The persisted in-app copy a recipient sees in their inbox. Identity by
`NotificationId`; mutable only in its read/unread flag.

| Attribute | Type | Notes |
|-----------|------|-------|
| `id` | `NotificationId` | Identity; immutable. |
| `recipientId` | `PrincipalId` | Whose inbox; the self-scope key (`BR-NOTIF-12`). Reused from `unit-platform-auth`. |
| `requestId` | `RequestId` | The vacation request this is about (id ref, not object). |
| `eventType` | `WorkflowEventType` | Which transition triggered it. |
| `title` | `string` | Rendered, PII-minimal in-app headline. |
| `body` | `string` | Rendered text; encrypted at rest if it embeds PII (`BR-PII-3`). |
| `dedupeKey` | `DedupeKey` | Idempotency token (`BR-NOTIF-9`). |
| `read` | `boolean` | Unread by default; `markRead` sets true (idempotent). |
| `createdAtMs` | `number` | Epoch ms of creation. |

Behaviour: `markRead()` is idempotent (already-read is a no-op success). No other
field is edited after creation.

### `NotificationDelivery` (append-only operational record)

One record per `(recipient, event)` handling pass; the idempotency and
dead-letter reconciliation surface. **Append-only** and never mutated
(`BR-NOTIF-11`) — this is an operational trail, distinct from the compliance
`audit-trail` owned by another unit.

| Attribute | Type | Notes |
|-----------|------|-------|
| `recipientId` | `PrincipalId` | The notified principal. |
| `dedupeKey` | `DedupeKey` | Together with `recipientId`, the idempotency key. |
| `requestId` | `RequestId` | The subject request (id ref). |
| `eventType` | `WorkflowEventType` | Triggering transition. |
| `outcomes` | `readonly ChannelOutcome[]` | Per-channel result (email + in-app). |
| `atMs` | `number` | When the pass ran. |

## Ports (hexagonal seams — one responsibility each)

### `RecipientDirectoryPort` (read-only)
- `resolve(principalId): Promise<RecipientContact | null>` — pseudonymous id →
  contact. Also `resolveActor(department, role)` to find "the team lead of dept X"
  / "HR for dept X" for next-actor notification (`BR-NOTIF-3`). Backing store
  (IdP / HRIS / internal directory) is an infrastructure decision.

### `EmailSenderPort`
- `send(message: EmailMessage): Promise<Result<void, NotificationError>>` —
  dispatch one email. Transient failures are retryable (`BR-NOTIF-10`); the
  in-memory dev/test adapter records sent messages for assertions.

### `InAppInboxPort`
- `put(n: InAppNotification): Promise<Result<void, NotificationError>>` —
  persist an in-app notification (idempotent on `(recipientId, dedupeKey)`).
- `list(recipientId, unreadOnly?): Promise<InAppNotification[]>` — self-scoped
  read (`BR-NOTIF-12`).
- `markRead(id): Promise<Result<void, NotificationError>>` — idempotent.
- Interface lives in the domain/ports layer; the in-memory adapter is the
  dev/test implementation, swappable for a durable store in production — the same
  hexagonal seam as `SessionStore` / `RoleDirectoryPort` / `EventPublisher`.

### `NotificationDeliveryRepository` (append-only)
- `hasDelivery(recipientId, dedupeKey): Promise<boolean>` — the idempotency
  guard (`BR-NOTIF-9`).
- `record(delivery: NotificationDelivery): Promise<void>` — append-only
  (`BR-NOTIF-11`).

## Consumed Event Contract (read-only, from `unit-request-workflow`)

This unit does **not** define events; it subscribes to the shipped union. Each
carries `requestId`, `ownerId`, `department`, `actorId`, `status`, `atMs`
(PII-free), and `RequestRejected` additionally carries `rejectedStage`:

- `RequestSubmitted` → notify owner + team lead.
- `RequestValidated` → notify owner + HR.
- `RequestApproved` → notify owner (approver optional).
- `RequestRejected` (with `rejectedStage`) → notify owner (rejecting actor
  optional).
- `RequestWithdrawn` → notify owner (team lead optional).

## Relationships & Lifecycle

```
unit-request-workflow ──publish(WorkflowEvent)──► EventPublisher (choreography bus, PII-free)
                                                        │  subscribe(handler)
                                                        ▼
                                              NotificationService.handleEvent(event)
                                                        │
        recipientPolicy(event) ──► [ownerId, next-actor] ──resolve──► RecipientDirectoryPort (read-only, PII late)
                                                        │
                        renderEmail / renderInApp (NotificationTemplate by eventType)
                                                        │
                 ┌──────────────────────────────────────┴───────────────────────────────┐
                 ▼                                                                        ▼
        EmailSenderPort.send(EmailMessage)                              InAppInboxPort.put(InAppNotification)
                 │  ChannelOutcome(Email)                                      │  ChannelOutcome(InApp)
                 └───────────────────────────┬──────────────────────────────────┘
                                             ▼
                        NotificationDeliveryRepository.record(NotificationDelivery)   (append-only, idempotent)

recipient (AuthenticatedPrincipal) ──listForRecipient / markRead──► InAppInboxPort   (self-scoped, BR-NOTIF-12)
```

Lifecycle of an `InAppNotification`: `created (unread) → read` (via idempotent
`markRead`); never deleted implicitly (retention deferred to
infrastructure/compliance — see `memory.md` open question). `NotificationDelivery`
records are write-once.

Cross-unit references use **ids, not object graphs**: the notification unit holds
`RequestId` / `PrincipalId` refs and resolves contact PII only at send time,
never receiving or storing the `VacationRequest` aggregate itself — preserving the
least-coupling boundary the `unit-request-workflow` `domain-entities` established.
