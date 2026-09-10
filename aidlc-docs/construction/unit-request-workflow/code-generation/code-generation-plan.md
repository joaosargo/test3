# Code Generation Plan — `unit-request-workflow`

Implementation plan for the **Vacation Request Workflow** unit — the command-path
core that owns the `VacationRequest` aggregate and drives the strict two-stage
approve/reject-only workflow. Grounded in the unit's `business-logic-model`,
`domain-entities`, `business-rules`, and `frontend-components` functional-design
artifacts, the `performance-design` / `security-design` NFR artifacts, and the
`unit-of-work` / `requirements` upstream. Consumes the shipped
`unit-platform-authz` (`src/authz/index.ts`) and `unit-platform-auth`
(`src/domain/entities.ts`, `src/http/session-middleware.ts`) surfaces read-only.

## Conventions adopted (shipped monolith + tech-stack-decisions)

- TypeScript 5.5 strict, Node ≥ 20, ESM with `.js` import specifiers, Express 4.
- Hexagonal layout: pure aggregate + `VacationRequestRepository` port + in-memory
  adapter; service orchestrates authz + state guard + persist + event emit.
- `Result<T, WorkflowError>` for expected failures (never throw); throwing
  reserved for misconfiguration — mirrors `SsoError` / `AuthzError`.
- Feature folder `src/workflow/` mirroring the `src/authz/` and `src/hris/`
  sub-unit layout (domain / ports / adapters / services / http / index).
- Append-only history (`BR-INV-4`), optimistic concurrency (`BR-INV-2/3`),
  event-per-transition (`BR-INV-5`), PII-free codes (`BR-INV-6`).
- Vitest (`src/**/*.test.ts` auto-globbed), ESLint, coverage ≥ 80% line / 75%
  branch. Standard test strategy: unit tests per component + an HTTP integration
  test for the router boundary.
- `data-testid` attributes on all interactive elements of the static UI page.

## Story → code-step traceability

| Story | Requirement(s) | Plan steps |
|-------|----------------|------------|
| `story-submit-request` | `req-submit-vacation-request` | 2, 3, 4, 5, 6, 7, 8, 9, 11 |
| `story-lead-validate` | `req-team-lead-approve-reject`, `req-status-tracking` | 2, 3, 4, 5, 6, 7, 8, 9, 11 |
| `story-hr-approve` | `req-hr-approve-reject-no-override` | 2, 3, 4, 5, 6, 7, 8, 9, 11 |

## Steps

- [x] **Step 1 — Feature scaffold.** `src/workflow/` sub-tree. No new npm
  dependency (adopt shipped stack).
- [x] **Step 2 — Domain value objects & errors** (`domain/value-objects.ts`,
  `domain/errors.ts`). `RequestId`, `DateRange` (+ `rangesOverlap`,
  `isValidCalendarDate`), `RequestStatus`, `WorkflowStage`, `Transition`,
  `SubmitRequestInput`, `WorkflowError`. Traces `domain-entities`;
  `business-rules` `BR-VAL-*`, `BR-INV-6`.
- [x] **Step 3 — `VacationRequest` aggregate** (`domain/vacation-request.ts`).
  Pure FSM, guarded transitions, append-only history, monotonic version.
  `business-logic-model` state machine; `business-rules` `BR-WF-1..9`, `BR-INV-*`.
- [x] **Step 4 — Aggregate unit tests** (`domain/vacation-request.test.ts`, 10).
- [x] **Step 5 — Events + repository/publisher ports** (`domain/events.ts`,
  `ports/vacation-request-repository.ts`, `ports/event-publisher.ts`).
- [x] **Step 6 — In-memory adapters** (`adapters/*`), append-only + optimistic.
- [x] **Step 7 — `WorkflowService`** (`services/workflow-service.ts`).
  Authz-first, state-guarded, concurrency-checked, event-per-transition.
  `business-logic-model` Workflows A/B/C; `business-rules` `BR-WF-7/8`.
- [x] **Step 8 — `WorkflowService` unit tests** (`services/workflow-service.test.ts`, 15).
- [x] **Step 9 — HTTP router** (`http/workflow-router.ts`).
  `requireSession → requirePermission → handler`; `WorkflowError` → HTTP status.
- [x] **Step 10 — HTTP integration test** (`http/workflow-router.test.ts`, 5)
  via ephemeral `http.Server` + built-in `fetch` (no new dependency).
- [x] **Step 11 — Static request UI page** (`public/requests.html`) with
  `data-testid` on every interactive element; advisory balance/overlap slots.
- [x] **Step 12 — Public barrel** (`src/workflow/index.ts`) mirroring
  `src/authz/index.ts`.
- [x] **Step 13 — Verify.** `npm run typecheck`, `npm run lint`, `npm test` all
  green (104 tests; coverage 96.3% line / 84% branch).

## Test configuration

No new test config needed: root `vitest.config.ts` auto-globs `src/**/*.test.ts`
and applies coverage thresholds; `tsconfig.json` already includes `src/**/*.ts`.
Static HTML is non-`.ts` and excluded from coverage.

## Notes / interpretations

- Runtime has no Task subagent; the developer generated all code directly into
  the working tree (the methodology "delegate" step is a no-op here).
- Withdraw permitted only from `Submitted` (conservative `BR-WF-9` default).
- Balance/overlap are advisory display slots only — never a gate (`BR-VAL-6`).
