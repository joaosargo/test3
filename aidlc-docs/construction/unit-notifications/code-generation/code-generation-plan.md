# Code Generation Plan — `unit-notifications`

Layer-by-layer implementation plan for the **Notification** unit. Grounds in the
unit's functional-design (`business-logic-model`, `domain-entities`,
`business-rules`, `frontend-components`), nfr-design (`reliability-design`,
`security-design`, `performance-design`), the `unit-of-work`
(`unit-notifications — Notification`) definition, and `requirements`
(`req-notifications-email-inapp`). This unit is a choreographed **event
consumer** of `unit-request-workflow` (already completed) — it subscribes to the
shipped `WorkflowEvent` union via the `EventPublisher` seam and never calls the
workflow back.

## Story → Code-Step Traceability

Sole story assigned to this unit by the story map:

- **`story-notifications`** — Email and in-app notifications on state changes
  (covers `req-notifications-email-inapp`). Realized by Steps 2–9 below.

Out of scope (belongs to `unit-sla-escalation`): timed SLA reminders /
escalation (`req-sla-reminder-escalation`). No scheduler logic here.

## Steps

- [x] **Step 1 — Project structure setup.** New feature module under
  `src/notifications/` mirroring the shipped hexagonal layout
  (`domain/`, `ports/`, `services/`, `adapters/`, `http/`, `index.ts`). No new
  npm dependencies (reuse existing `express`, node `crypto`). → *scaffolding*
- [x] **Step 2 — Domain value objects & entities.**
  `domain/value-objects.ts` (`NotificationId`, `NotificationChannel`,
  `ChannelOutcome`, `DedupeKey` + `deriveDedupeKey`, `RecipientContact`,
  `EmailMessage`), `domain/entities.ts` (`InAppNotification`,
  `NotificationDelivery`), `domain/errors.ts` (`NotificationError`). Reuses
  `PrincipalId`, `RequestId`, `WorkflowEventType` read-only. → `story-notifications`
  (`domain-entities`, `BR-NOTIF-9/11`, `BR-PII-4`)
- [x] **Step 3 — Business logic layer.** `domain/recipient-policy.ts` (pure
  event→recipient mapping, `BR-NOTIF-1..5`), `domain/templates.ts` (PII-free
  in-app + email rendering, `BR-PII-1`), `services/notification-service.ts`
  (`handleEvent` pipeline + self-scoped inbox reader, `BR-NOTIF-6..12`,
  `BR-NOTIF-8` non-blocking). → `story-notifications`
- [x] **Step 4 — Business logic tests.**
  `services/notification-service.test.ts` (13 tests: recipient fan-out,
  idempotency, degradation, dead-letter, self-scope),
  `domain/recipient-policy.test.ts` (7), `domain/templates.test.ts` (6). →
  `story-notifications`
- [x] **Step 5 — Ports (hexagonal seams).** `ports/recipient-directory.ts`,
  `ports/email-sender.ts`, `ports/in-app-inbox.ts`,
  `ports/notification-delivery-repository.ts`. → `domain-entities` Ports
- [x] **Step 6 — Repository / adapter layer.** In-memory dev/test doubles:
  `in-memory-recipient-directory.ts`, `in-memory-email-sender.ts`,
  `in-memory-in-app-inbox.ts` (idempotent + self-scoped),
  `in-memory-notification-delivery-repository.ts` (append-only). → `reliability-design`
- [x] **Step 7 — Adapter tests.** `adapters/in-memory-in-app-inbox.test.ts`
  (5 tests: idempotency, newest-first, unread filter, idempotent mark-read,
  failure mode). → `story-notifications`
- [x] **Step 8 — HTTP layer (in-app inbox surface).**
  `http/notification-router.ts` — `GET /notifications`,
  `POST /notifications/:id/read`, guarded by `requireSession`; self-scope
  enforced in the service. Email channel is headless (no route). →
  `frontend-components`, `story-notifications`
- [x] **Step 9 — HTTP + integration tests.**
  `http/notification-router.test.ts` (5 tests: 401/200/204/403/404),
  `notification-choreography.test.ts` (2 tests: workflow⇄notification
  boundary, non-blocking). → `story-notifications`, `BR-NOTIF-8/12`
- [x] **Step 10 — Public API + choreography wiring.** `index.ts` (encapsulated
  surface, mirrors `src/workflow/index.ts`), `subscribe.ts`
  (`registerNotificationSubscriber`). → `business-logic-model` Data Flow
- [x] **Step 11 — Test configuration.** Reuses the shipped root
  `vitest.config.ts` (globbed `src/**/*.test.ts`, 80% thresholds) — no per-unit
  config needed.
- [x] **Step 12 — Documentation.** Inline JSDoc on every module citing the
  driving rule ids; this plan + the code-summary artifact.

## Verification (definition of done)

- `npm run typecheck` — clean (tsc `--noEmit`).
- `npm run lint` — clean (eslint, `no-explicit-any` error-level).
- `npm test` — 142/142 pass (38 new for this unit; no regressions).
- `npx vitest run --coverage` — 97% statements overall; `src/notifications` at
  100% lines/branches/functions (≥ the 80/75 thresholds).

## Notes / deviations

- **Composition root left unchanged.** As with the shipped `unit-request-workflow`
  and `unit-hris-balance`, the top-level `src/app.ts` / `src/server.ts` are not
  modified per-unit; the unit encapsulates its router + subscriber behind
  `index.ts` for a later composition stage to mount. Keeps the unit lane isolated.
- **No `notification:*` permission added.** The closed authz permission set is
  owned by `unit-platform-authz`; the in-app inbox is self-scoped (viewer-keyed),
  guarded by `requireSession` only, matching `frontend-components`.
