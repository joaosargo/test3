# Code Summary — `unit-notifications`

Implementation summary for the **Notification** unit — the choreographed
side-effect that turns each vacation-request state change into an **email** and
an **in-app** notification. Realizes `story-notifications` /
`req-notifications-email-inapp`, grounded in the unit's `business-logic-model`,
`domain-entities`, `business-rules`, `frontend-components`, `reliability-design`,
`security-design`, and the `unit-of-work` (`unit-notifications — Notification`)
definition. The unit consumes the shipped `WorkflowEvent` contract from
`unit-request-workflow` (dependency, already completed) via the `EventPublisher`
choreography seam and never calls the workflow back.

## Files Created

All new, under `src/notifications/` (feature-based hexagonal layout mirroring
`src/workflow/` and `src/authz/`):

### Domain
- `domain/value-objects.ts` — `NotificationId`, `NotificationChannel`,
  `ChannelOutcome`/`ChannelStatus`/`OutcomeReason`, `DedupeKey` +
  `deriveDedupeKey` (SHA-256 of `requestId|eventType|atMs`, `BR-NOTIF-9`),
  `RecipientContact` (PII-bearing, transient), `EmailMessage`.
- `domain/entities.ts` — `InAppNotification` (read/unread; identity by id),
  `NotificationDelivery` (append-only operational record, `BR-NOTIF-11`).
- `domain/errors.ts` — `NotificationError` taxonomy (`NOT_FOUND`, `FORBIDDEN`,
  `RECIPIENT_UNRESOLVED`, `CHANNEL_ERROR`), PII-free, `Result`-returned — mirrors
  the shipped `WorkflowError`/`AuthzError`.
- `domain/recipient-policy.ts` — pure `recipientsFor(event, config)` mapping
  (`BR-NOTIF-1..5`): owner always required, next-actor (team lead / HR) on
  submit/validate, optional actor copies on terminal events.
- `domain/templates.ts` — `renderInApp` (PII-free, `BR-PII-1`) and `renderEmail`
  (greets by resolved display name, used transiently, `BR-PII-2`).

### Ports (hexagonal seams)
- `ports/recipient-directory.ts` — read-only `resolve` / `resolveActor`.
- `ports/email-sender.ts` — `send(EmailMessage): Result<void, NotificationError>`.
- `ports/in-app-inbox.ts` — `put` / `list` / `findById` / `markRead`.
- `ports/notification-delivery-repository.ts` — `hasDelivery` / `record`
  (append-only).

### Services
- `services/notification-service.ts` — `NotificationService` with
  `handleEvent` (Workflow N-A: resolve recipients → idempotency guard → resolve
  contact → render + dispatch both channels independently → append delivery
  record) and `listForRecipient` / `markRead` (Workflow N-B, self-scoped
  `BR-NOTIF-12`). Clock + id generator injected for determinism.

### Adapters (dev/test doubles)
- `adapters/in-memory-recipient-directory.ts`
- `adapters/in-memory-email-sender.ts` (with `setFailing` for the dead-letter path)
- `adapters/in-memory-in-app-inbox.ts` (idempotent, newest-first, self-scoped)
- `adapters/in-memory-notification-delivery-repository.ts` (append-only)

### HTTP
- `http/notification-router.ts` — `GET /notifications`,
  `POST /notifications/:id/read`; `requireSession`-guarded, PII-free error
  envelope, `204` on mark-read.

### Composition
- `index.ts` — encapsulated public API surface.
- `subscribe.ts` — `registerNotificationSubscriber(publisher, service)`
  choreography wiring.

### Tests (38 new)
- `services/notification-service.test.ts` (13)
- `domain/recipient-policy.test.ts` (7)
- `domain/templates.test.ts` (6)
- `adapters/in-memory-in-app-inbox.test.ts` (5)
- `http/notification-router.test.ts` (5)
- `notification-choreography.test.ts` (2)

## Files Modified

None. The composition root (`src/app.ts` / `src/server.ts`) was intentionally
left unchanged, matching the shipped `unit-request-workflow` /
`unit-hris-balance` convention (unit encapsulates its surface behind `index.ts`
for a later composition stage). No existing file was edited — this is a purely
additive brownfield change, so blast radius is isolated (no dependents of shipped
modules are touched).

## Key Implementation Decisions

1. **Pure event consumer, non-blocking (`BR-NOTIF-8`).** `handleEvent` always
   resolves `ok` with a per-recipient/per-channel batch result; failures are
   values inside the result, never thrown — a notification failure cannot reverse
   the already-committed workflow transition (workflow `BR-INV-5`).
2. **At-least-once + idempotency (`BR-NOTIF-9`).** `deriveDedupeKey` +
   `hasDelivery(recipient, dedupeKey)` make redelivery a per-recipient no-op;
   exactly-once is deliberately not attempted.
3. **Independent channels, graceful degradation (`BR-NOTIF-6/7`).** Email and
   in-app dispatch separately; no-email-contact → `Skipped(NO_EMAIL_CONTACT)`
   while in-app still lands; a failing channel → `DeadLettered` without aborting
   the other.
4. **PII discipline (`req-nfr-security-pii`, `BR-PII-1/2/4`).** The bus stays
   PII-free (ids only); contact PII is resolved late, used transiently, never
   logged and never written to a delivery record; all codes are PII-free.
5. **Self-scope, server-authoritative (`BR-NOTIF-12`).** The inbox is keyed on
   the viewing principal; cross-principal mark-read → `403`, unknown id → `404`.
   No `notification:*` permission was added to the closed authz set — the inbox
   is viewer-keyed, not role-keyed (per `frontend-components`).
6. **Convention fidelity.** Reused the shipped `Result<T,E>`, error-class,
   `index.ts` encapsulation, and in-memory-adapter patterns; no new dependency;
   node `crypto` for the dedupe hash (as `src/domain/crypto.ts` does).

## Test Coverage Summary

- Strategy: **Standard** — per-component unit tests + integration stubs.
- **142/142** tests pass (38 new; no regressions in the 104 pre-existing).
- `npm run typecheck` clean; `npm run lint` clean.
- Coverage: **97.09%** statements overall; `src/notifications/` at **100%**
  lines / branches / functions — above the repo thresholds (80/75).

## Deviations from the Plan

None functionally. The only planned "step" that produced no artifact was Step 11
(test config) — the shipped root `vitest.config.ts` already globs
`src/**/*.test.ts`, so no per-unit config was needed.
