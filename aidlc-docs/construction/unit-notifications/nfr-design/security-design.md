# Security Design — `unit-notifications`

Concrete security architecture for the **Notification** unit — the authentication
inheritance, authorization model, encryption, PII-handling, input-validation, and
audit/logging decisions that satisfy the unit's `security-requirements`. The design
is grounded in the PII invariant chain established across the platform
(`security-requirements` BR-PII rules, mirrored from `unit-platform-authz` and
`unit-request-workflow`), the choreography-consumer boundary in
`business-logic-model`, and the data-protection ADRs in `tech-stack-decisions`
(`ADR-NOTIF-03`/`04` provider ports, `ADR-NOTIF-06` observability).

Because this unit carries employee PII (email, display name, notification bodies)
under a GDPR-aligned posture, security here is dominated by **PII minimisation and
containment**, not by a new authentication surface — the unit introduces no login
path of its own.

The security controls below interlock with the other NFR designs: the bounded
worker concurrency and queue backpressure specified against
`scalability-requirements` are the DoS containment mechanism; the per-channel
circuit breaker and dead-letter handling specified against
`reliability-requirements` bound the effect of a hostile or failing provider; and
the async off-hot-path budget in `performance-requirements` ensures none of these
security checks are pushed onto the workflow's critical path.

## Authentication

- **Inherited, not owned.** The notification unit performs no authentication. The
  only authenticated surface is the in-app inbox read side (`listForRecipient` /
  `markRead`), which receives an already-`AuthenticatedPrincipal` established by
  `unit-platform-auth` (SSO-only). This matches `security-requirements`
  (authentication inherited from the platform auth unit) and the
  `business-logic-model` Workflow N-B shape.
- **The event-consumer path is unauthenticated by design** because it never faces a
  user: it consumes internal `WorkflowEvent`s off the choreography bus. Its trust
  boundary is the broker, not an end user.

## Authorization Model

- **In-app inbox is strictly self-scoped.** A principal may `list` and `markRead`
  ONLY their own notifications (`business-logic-model` N-B, business-rules
  BR-NOTIF-12, reusing `unit-platform-authz` `BR-AUTHZ-7` employee self-scope).
  The scope key is `InAppNotification.recipientId == principal.principalId`.
- **Fail closed.** A cross-principal inbox request returns `forbidden`; a
  `markRead` on another principal's notification returns `forbidden`; an unknown id
  returns `notFound`. No notification content leaks across principals
  (`security-requirements` threat considerations).
- **No role elevation here.** The unit does not make role/department authorization
  decisions on the delivery path — recipient selection is a business policy
  (BR-NOTIF-1..5), not an access-control decision, and next-actor resolution is a
  read-only directory lookup.

## PII Handling — Defense in Depth

PII containment is the central security control, layered:

1. **Bus stays PII-free (`security-requirements` BR-PII-1).** Consumed
   `WorkflowEvent`s carry only pseudonymous ids (`requestId`, `ownerId`,
   `actorId`), `department`, `status`, `atMs` — never email or free-text reason.
   The unit adds no PII to any event it observes. This keeps PII off the broker and
   out of any broker-side logging/replay.
2. **Late, transient contact resolution (BR-PII-2).** `RecipientContact` (email,
   displayName) is resolved at send time via `RecipientDirectoryPort`, lives only
   in memory while a message is built, and is discarded after dispatch. It is
   cached only in-process (see `performance-design`), never in a shared store.
3. **Never logged (BR-PII-2).** `redactForLog` is applied at every serialization
   boundary — logs, error `cause`, metrics, and `NotificationDelivery` records
   carry only pseudonymous ids and PII-free machine codes
   (`RECIPIENT_UNRESOLVED`, `NO_EMAIL_CONTACT`, `CHANNEL_TRANSIENT`,
   `CHANNEL_DEAD_LETTERED`). Error codes are PII-free by construction (BR-PII-4).
4. **Encryption at rest for persisted bodies (BR-PII-3).** The one place PII can
   become durable is a persisted in-app notification `body`/`title` that embeds
   contact or reason context. Such fields are stored via `CryptoPort` field-level
   encryption; plaintext PII is never written to durable storage. A
   `CryptoPort`-unavailable write **fails closed** (the in-app persist errors and is
   retried/dead-lettered rather than writing plaintext).

## Encryption

| Data | In transit | At rest |
|------|-----------|---------|
| Enqueued `WorkflowEvent` (PII-free) | TLS to broker | Broker-managed encryption; contains no PII regardless |
| Email to provider | TLS to `EmailSenderPort` provider endpoint | Provider-side; body transient on our side |
| In-app notification body/title (PII-bearing) | TLS to store | **Field-level encryption via `CryptoPort`** (BR-PII-3) |
| `NotificationDelivery` records | TLS to store | Encrypted-at-rest store; records are PII-free so this is defense-in-depth |
| Cached `RecipientContact` | n/a (in-process) | Never persisted; memory-only |

TLS everywhere and encryption at rest align with the platform data-protection
posture in `tech-stack-decisions` (mirrors `ADR-AUTH-05` region-pinned encryption
at the platform level).

## Input Validation

- **Event-type allow-list (fail closed).** Only the five known `WorkflowEvent`
  types produce notifications; an unknown/unmapped event type is a logged advisory
  no-op with no recipients and no send (`business-rules` Validation & Edge Cases).
  This prevents a malformed or injected event from driving unexpected sends.
- **Recipient ids are opaque and validated against the directory.** A recipient id
  that does not resolve is recorded `skipped(RECIPIENT_UNRESOLVED)` — the unit never
  fabricates a destination address.
- **Template rendering escapes output.** Rendered email/in-app bodies escape
  interpolated values so a value carried from upstream cannot inject markup/script
  into an email client or the in-app UI (XSS containment on the in-app read side).
- **Self-scope guard on reads** (see Authorization) validates ownership before
  returning any inbox content.

## Threat Model (STRIDE — Notification Boundary)

| Threat | Vector | Mitigation |
|--------|--------|------------|
| **Spoofing** | Forged event injected onto the bus | Trust boundary is the broker (TLS, broker auth); event-type allow-list; recipients resolved from the directory, not from event free-text |
| **Tampering** | Delivery record altered to hide/duplicate a send | `NotificationDelivery` is append-only (BR-NOTIF-11); integrity of the operational trail |
| **Repudiation** | "I never got notified" | Append-only per-recipient/per-channel `NotificationDelivery` outcomes provide an operational trail (distinct from the compliance audit-trail) |
| **Information disclosure** | PII in logs / bus / cross-principal inbox | BR-PII-1..4 (PII-free bus, redacted logs, encrypted bodies); strict self-scope on inbox reads |
| **Denial of service** | Event flood exhausts provider connections | Bounded worker concurrency + backpressure (see `scalability-design`); per-channel circuit breaker sheds a failing provider |
| **Elevation of privilege** | Reading another principal's inbox | Self-scope fail-closed authorization (BR-NOTIF-12) |

## Audit & Operational Logging

- **Operational trail, not compliance audit.** `NotificationDelivery` records are an
  append-only *operational* fact trail for idempotency and dead-letter
  reconciliation — explicitly distinct from the immutable compliance `audit-trail`
  owned by another unit (`business-rules` BR-NOTIF-11).
- **PII-free structured logs** with correlation on `requestId`/`dedupeKey` and
  channel outcome codes, per `ADR-NOTIF-06` observability, so operators can trace a
  delivery without ever seeing PII.

## Compliance Alignment

GDPR-aligned data minimisation is achieved structurally: the bus and durable
operational records carry no PII, contact PII is resolved late and held
transiently, any persisted PII body is encrypted, and retention of in-app
notifications/delivery records is bounded (deferred to infrastructure-design /
compliance, see `scalability-design` and memory open question) — consistent with
`security-requirements` compliance-alignment.
