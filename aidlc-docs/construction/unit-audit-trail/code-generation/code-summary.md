---
consumes: [business-logic-model, business-rules, domain-entities, performance-design, security-design, deployment-architecture, unit-of-work, requirements, code-generation-plan]
unit: unit-audit-trail
stage: code-generation
---

# Code Summary — `unit-audit-trail`

Implementation summary for the **Immutable Audit Trail** unit. All 16 steps of
the `code-generation-plan` were executed; typecheck, lint, and the full test
suite are green (132 tests, of which 28 are new for this unit). The unit ships
as an in-process module `src/audit/` mirroring the shipped `src/hris/`,
`src/authz/`, and `src/workflow/` layouts, per `deployment-architecture`
(embedded module of the modular monolith).

## Files Created

### Domain (`src/audit/domain/`)
- **`audit-record.ts`** — the immutable `AuditRecord` entity + value objects
  (`AuditId`, `RecordHash`, `GENESIS`, `EventType`, `TrailQuery`), the
  `AuditError` value-level failure, the pure `createAuditRecord` factory and
  `recomputeHash`, and the `SEVEN_YEARS_MS` retention constant. Realizes
  `domain-entities`; `BR-AUD-1a/1b`, `BR-AUD-5a`, `BR-AUD-6`, `BR-AUD-7`,
  `BR-AUD-8`.
- **`canonical.ts`** — deterministic, version-tagged canonical serializer +
  SHA-256 hashing + UUID id factory. Realizes `BR-AUD-6a`.

### Ports (`src/audit/ports/`)
- **`audit-store.ts`** — the append-only `AuditStore` port: `append` +
  `findByKey`/`chainHead`/`findByRequest`/`query` reads **only**. No
  `update`/`delete` at the contract level (`BR-AUD-5`,
  `req-constraint-append-only-store`).

### Services (`src/audit/services/`)
- **`audit-service.ts`** — `recordEvent` (validate → dedup → chain → append,
  idempotent), `getRequestTrail`, `queryTrail`, `verifyChain`, plus the inbound
  ACL validation of `WorkflowEvent` → `AuditableEvent`. Realizes all four
  workflows in `business-logic-model`; `BR-AUD-1..9`.
- **`audit-service.test.ts`** — 17 tests: one record per event type, field
  mapping, distinct business/ingest time, 7-year retention, idempotent dedup,
  per-request chaining, malformed-event fail-closed variants, status/type and
  `rejectedStage` consistency, PII-free errors, intact-chain verify,
  hash-mismatch + broken-link detection, read non-mutation.

### Adapters (`src/audit/adapters/`)
- **`in-memory-audit-store.ts`** — dev/test append-only store with per-request
  partitions, dedup index, frozen records; no mutation path.
- **`in-memory-audit-store.test.ts`** — 6 tests: append/read-back order,
  chain-head progression, dedup key lookup, query filtering, copy-on-read
  isolation, frozen immutability.

### HTTP (`src/audit/http/`)
- **`audit-router.ts`** — three guarded read-only routes with the PII-free
  `AuditRecordView` DTO and `Cache-Control: no-store`. `requireSession` →
  `requirePermission` pipeline (`security-design` C6; `BR-AUD-8/9`;
  `frontend-components`).
- **`audit-router.test.ts`** — 5 tests: 401 unauthenticated, 200 trail read,
  intact-chain verify, filtered query with PII-free view, 403 for a non-auditor
  role. Uses the real `AuthService` + `AuthzService` composition, matching
  `balance-router.test.ts`.

### Config (`src/audit/config/`)
- **`audit-policy.ts`** — injectable `AuditPolicy` (retention window + serializer
  version tag) with `DEFAULT_AUDIT_POLICY`.

### Composition (`src/audit/index.ts`)
- Public API surface: `AuditService`, `buildAuditRouter`, `InMemoryAuditStore`,
  the domain re-exports, plus the composition helpers `createAuditService`,
  `mountAuditRoutes`, and `subscribeAuditTrail(publisher, service)` — the
  choreography seam that binds `recordEvent` to the workflow `EventPublisher`.

### Frontend (`public/audit.html`)
- Thin read-only auditor inspection view (filter bar, integrity banner, records
  table) with `data-testid` attributes on all interactive elements, matching the
  static-HTML posture of `public/requests.html`.

## Files Modified
- **`README.md`** — added a `Module: unit-audit-trail` section documenting the
  sink, its guarded endpoints, and the auditor UI.

## Key Implementation Decisions
- **Immutability enforced at the type/contract level** — the `AuditStore` port
  has no mutation method, and records are frozen; the append-only guarantee is
  structural, not conventional (`BR-AUD-5`, `BR-AUD-5a`).
- **Per-request hash chain** — `prevHash`/`hash` link records within a
  `requestId` partition; `verifyChain` is a pure walk that distinguishes
  `hash-mismatch` from `broken-link` (`BR-AUD-4`, `BR-AUD-6`).
- **Idempotent ingest** — dedup key `(eventType, requestId, occurredAtMs)` makes
  at-least-once choreography delivery safe (`BR-AUD-2`).
- **Result-typed errors, never thrown** — expected failures are values, matching
  the shipped `Result<T,E>` convention across auth/authz/hris/workflow.
- **Consumes upstream types read-only** — `WorkflowEvent`, `RequestId`,
  `DepartmentCode`, `RequestStatus`, `WorkflowStage`, `PrincipalId` are imported,
  never redefined (`domain-entities` conformist-with-ACL boundary).

## Test Coverage Summary
- Full suite: **132 tests pass** (28 new for this unit); no regressions.
- `src/audit` coverage: ~96% statements/lines, ~83% branches — above the
  configured 80/75 thresholds in `vitest.config.ts`. `index.ts` is coverage-
  excluded by the shipped `src/**/index.ts` glob (composition wiring).
- Verified: `npm run typecheck` (clean), `npm run lint` (clean), `npm test`
  (green).

## Deviations from the Plan
- **Auditor read permission** — there is no dedicated `audit:read` permission in
  the shipped `unit-platform-authz` `PERMISSIONS` set, and adding one would
  require modifying that unit (out of this unit's lane). The read routes are
  therefore guarded with the closest existing permission,
  `request:view-department` (an HR/compliance-scoped read grant). This matches
  the functional-design `memory.md` open question (auditor scope, assumed
  org-wide pending authz confirmation) and should be revisited if a first-class
  `audit:read` permission is later introduced in `unit-platform-authz`.
- **`verify` endpoint returns 200 for an integrity violation** — a detected
  tamper is a valid audit *verdict* the auditor must see (`{ integrity:
  "violated", auditId, kind }`), not a 4xx/5xx error; genuine input faults still
  return 422. This follows `frontend-components` interaction flow #4 ("the
  records still render — the auditor must see the tampered evidence").
- **No new test config** — the shipped `vitest.config.ts` already globs
  `src/**/*.test.ts`; Step 14 confirmed no new config file was needed.

## Out of Scope (handed to infrastructure-design / later stages)
Durable WORM/object-lock store, DLQ wiring, scheduled integrity-sweep job,
retention-expiry purge job, and the KMS signing seam remain behind the swappable
`AuditStore` port, per `deployment-architecture` and the `logical-components`
handoff.
