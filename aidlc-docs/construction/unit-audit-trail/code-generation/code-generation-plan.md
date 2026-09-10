---
consumes: [business-logic-model, business-rules, domain-entities, performance-design, security-design, deployment-architecture, unit-of-work, requirements]
unit: unit-audit-trail
stage: code-generation
---

# Code Generation Plan — `unit-audit-trail`

Implementation plan for the **Immutable Audit Trail** unit — the compliance
system-of-record that subscribes to the workflow's published `WorkflowEvent`
stream and appends one immutable, hash-chained `AuditRecord` per accepted
transition, then serves those records read-only to the compliance auditor.

Grounded in the functional design (`business-logic-model`, `domain-entities`,
`business-rules`), the NFR design (`performance-design`, `security-design`),
`deployment-architecture`, the unit definition in `unit-of-work`, and the
driving `requirements` (`req-immutable-audit-trail`,
`req-constraint-append-only-store`, `req-nfr-audit-retention`,
`req-nfr-security-pii`).

## Scope & Story Traceability

This unit is scoped to a single story from `unit-of-work` /
`unit-of-work-story-map`:

- **`story-immutable-audit`** — Immutable append-only audit trail
  (covers `req-immutable-audit-trail`, `req-constraint-append-only-store`,
  `req-nfr-audit-retention`; persona `compliance-auditor`).

Every step below traces back to `story-immutable-audit` and the rules
`BR-AUD-1..9` from `business-rules`.

## Conventions (matched from the shipped monolith)

- TypeScript ESM, `.js` import specifiers, hexagonal `src/<unit>/` module layout
  mirroring `src/hris/`, `src/authz/`, `src/workflow/`.
- Shared `Result<T,E>` (`src/domain/result.ts`); expected failures are values,
  never thrown (`business-logic-model` error-handling posture).
- Consumes upstream types **read-only**: `WorkflowEvent` from
  `src/workflow/domain/events.ts`; `RequestId`, `DepartmentCode`,
  `RequestStatus`, `WorkflowStage` from `src/workflow/domain/value-objects.ts`;
  `PrincipalId` from `src/domain/entities.ts`. It does NOT redefine them
  (`domain-entities` conformist-with-ACL boundary).
- Guarded read routes reuse `requireSession` (unit-platform-auth) →
  `requirePermission` (unit-platform-authz), exactly as `workflow-router.ts`.

## Plan Steps

- [x] **Step 1 — Module scaffold.** Create `src/audit/` with `domain/`,
  `ports/`, `services/`, `adapters/`, `http/`, `config/`, and `index.ts`.
  (Enables all downstream steps; `story-immutable-audit`.)

- [x] **Step 2 — Domain value objects & errors.**
  `src/audit/domain/audit-record.ts` — `AuditId`, `RecordHash`, `GENESIS`,
  `EventType`, `AuditRecord` (immutable entity), `TrailQuery`, and the pure
  factory `AuditRecord.fromEvent` + `recomputeHash`. `AuditError` value-level
  failure with `MALFORMED_EVENT | INTEGRITY_VIOLATION | NOT_FOUND`.
  Retention constant `SEVEN_YEARS_MS`. (`domain-entities`; `BR-AUD-1a/1b`,
  `BR-AUD-5a`, `BR-AUD-6`, `BR-AUD-7`, `BR-AUD-8`; `story-immutable-audit`.)

- [x] **Step 3 — Canonical serializer + hash engine.**
  `src/audit/domain/canonical.ts` — pure, version-tagged deterministic
  serializer (stable key order, fixed number formatting) + SHA-256 hashing
  helper over `node:crypto`. (`BR-AUD-6`, `BR-AUD-6a`; integrity engine C4.)

- [x] **Step 4 — `AuditStore` port (append-only).**
  `src/audit/ports/audit-store.ts` — `append`, `findByKey`, `chainHead`,
  `findByRequest`, `query` **only**; no `update`/`delete` exists at the
  contract level. (`BR-AUD-5`, `req-constraint-append-only-store`; port C5.)

- [x] **Step 5 — Business logic: `AuditService`.**
  `src/audit/services/audit-service.ts` — `recordEvent` (validate → dedup →
  chain → append; idempotent), `getRequestTrail`, `queryTrail`, `verifyChain`.
  Inbound ACL mapping of `WorkflowEvent` → `AuditRecord`. (`business-logic-model`
  all four workflows; `BR-AUD-1..9`; `story-immutable-audit`.)

- [x] **Step 6 — Business logic tests.**
  `src/audit/services/audit-service.test.ts` — happy-path record for each of the
  5 event types, malformed-event fail-closed, idempotent dedup, per-request
  chain linkage, `verifyChain` intact + tamper-detection (hash-mismatch,
  broken-link), 7-year `retainUntilMs`, PII-free error codes, read
  non-mutation. (Standard strategy volume; `BR-AUD-1..9`.)

- [x] **Step 7 — In-memory `AuditStore` adapter.**
  `src/audit/adapters/in-memory-audit-store.ts` — dev/test append-only store
  with per-`requestId` partitions, dedup index, deep-frozen records. No mutation
  path. (`domain-entities` adapter seam; `BR-AUD-5`.)

- [x] **Step 8 — In-memory adapter tests.**
  `src/audit/adapters/in-memory-audit-store.test.ts` — append + read-back,
  chainHead progression, findByKey dedup, query filter, frozen immutability.

- [x] **Step 9 — Config.** `src/audit/config/audit-policy.ts` — retention window
  and canonical-serializer version tag as injectable policy (matches
  `balance-policy.ts` / `authz-policy.ts` pattern). (`BR-AUD-7`, `BR-AUD-6a`.)

- [x] **Step 10 — HTTP read surface.**
  `src/audit/http/audit-router.ts` — guarded read-only routes:
  `GET /audit/requests/:requestId`, `POST /audit/requests/:requestId/verify`,
  `GET /audit`. `requireSession → requirePermission` deny-by-default; PII-free
  envelope; `Cache-Control: no-store`. DTO mapping (`AuditRecordView`).
  (`frontend-components` interaction flows; `security-design` C6; `BR-AUD-8/9`.)

- [x] **Step 11 — HTTP tests.**
  `src/audit/http/audit-router.test.ts` — 401 unauthenticated, 403 forbidden,
  200 trail read, 200 verify intact / violation, empty-state, NOT_FOUND. Uses
  supertest-style Express harness matching `balance-router.test.ts`.

- [x] **Step 12 — Composition surface `index.ts`.**
  `src/audit/index.ts` — export `AuditService`, `buildAuditRouter`,
  `InMemoryAuditStore`, `createAuditService`/`mountAuditRoutes` helpers, and
  the subscription wiring helper `subscribeAuditTrail(publisher, service)` that
  binds `recordEvent` to the workflow `EventPublisher` (choreography seam).
  (`business-logic-model` Data Flow; `domain-entities` `WorkflowEventSubscription`.)

- [x] **Step 13 — Auditor UI.** `public/audit.html` — thin read-only inspection
  view (filter bar, integrity banner, records table) with `data-testid`
  attributes on interactive elements, matching the static-HTML posture of
  `public/requests.html`. (`frontend-components`; `story-immutable-audit`.)

- [x] **Step 14 — Test configuration.** No change required — the shipped
  `vitest.config.ts` already globs `src/**/*.test.ts` and `index.ts` is excluded
  from coverage. Confirm the new module falls under existing config; add the
  `src/audit/index.ts` exclusion is already covered by the `src/**/index.ts`
  glob. (No new config file needed.)

- [x] **Step 15 — Documentation.** Inline TSDoc on every module (grounding
  citations), plus a short update to `README.md` describing the audit-trail
  module and its endpoints.

- [x] **Step 16 — Verify.** `npm run typecheck`, `npm run lint`, `npm test`
  green before completion.

## Test Strategy

Active strategy: **Standard** — unit test files per component (5–8+ tests each)
plus integration-style HTTP tests for the read boundary. Test files are
mandatory (Steps 6, 8, 11) and are created here, not deferred to build-and-test.

## Out of Scope (handed to infrastructure-design / later stages)

- Durable WORM / object-lock store technology (C5), DLQ wiring (C2), scheduled
  integrity sweep (C7), retention purge job (C8), KMS signing seam (SD-AUD-10).
  This unit ships the pure domain + in-process module + in-memory adapter behind
  the swappable `AuditStore` port, per `deployment-architecture`.
