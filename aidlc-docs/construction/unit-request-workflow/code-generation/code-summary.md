# Code Summary — `unit-request-workflow`

Generation summary for the **Vacation Request Workflow** unit. All source lives
at the workspace root under `src/workflow/`; this document records what was
produced, key decisions, coverage, and deviations. Implements the
`code-generation-plan` for this unit and satisfies `story-submit-request`,
`story-lead-validate`, `story-hr-approve` (requirements
`req-submit-vacation-request`, `req-team-lead-approve-reject`,
`req-hr-approve-reject-no-override`, `req-status-tracking`).

## Files created

| Layer | File | Purpose |
|-------|------|---------|
| domain | `src/workflow/domain/value-objects.ts` | `RequestId`, `DateRange` (+ `rangesOverlap`, `isValidCalendarDate`), `RequestStatus`, `WorkflowStage`, `Transition`, `SubmitRequestInput` |
| domain | `src/workflow/domain/errors.ts` | `WorkflowError` taxonomy (`INVALID_INPUT`/`NOT_FOUND`/`FORBIDDEN`/`ILLEGAL_TRANSITION`/`STALE_STATE`), PII-free |
| domain | `src/workflow/domain/vacation-request.ts` | Pure `VacationRequest` FSM aggregate — guarded transitions, append-only history, monotonic version |
| domain | `src/workflow/domain/events.ts` | Past-tense domain events (one per transition) |
| ports | `src/workflow/ports/vacation-request-repository.ts` | Append-only repository port |
| ports | `src/workflow/ports/event-publisher.ts` | Choreography publisher port |
| adapters | `src/workflow/adapters/in-memory-vacation-request-repository.ts` | Dev/test append-only store with optimistic-concurrency guard |
| adapters | `src/workflow/adapters/in-memory-event-publisher.ts` | Dev/test event bus with in-process subscribers |
| services | `src/workflow/services/workflow-service.ts` | Orchestrated command path (submit / leadDecision / hrDecision / withdraw / getRequest) |
| http | `src/workflow/http/workflow-router.ts` | Express router; `requireSession → requirePermission → handler`; error→status mapping |
| barrel | `src/workflow/index.ts` | Public API (mirrors `src/authz/index.ts`) |
| ui | `public/requests.html` | SSO-guarded request/decision screens with `data-testid` attributes |
| test | `src/workflow/domain/vacation-request.test.ts` | 10 aggregate unit tests |
| test | `src/workflow/services/workflow-service.test.ts` | 15 service unit tests |
| test | `src/workflow/http/workflow-router.test.ts` | 5 HTTP integration tests |

No existing files were modified (additive, greenfield unit within the monolith).

## Key implementation decisions

- **Pure FSM aggregate, no I/O.** `VacationRequest` enforces the two-stage
  approve/reject-only state machine with guarded transitions returning
  `Result<_, WorkflowError>`. Authorization is checked by the service *before*
  invoking a transition (the aggregate never depends on the PDP), matching
  `business-logic-model` and keeping the aggregate unit-testable.
- **Authz-first, fail-closed ordering** (`business-rules` `BR-WF-7`): every
  command calls `AuthzService.decide` first, passing `{ department }` as the
  `AuthzResource` so the HR per-department and lead own-team predicates decide
  scope (`BR-WF-8`). This unit consumes `src/authz/index.ts` verbatim and never
  re-derives roles.
- **No-override is structural** (`req-hr-approve-reject-no-override`): the only
  mutating verbs are forward (validate/approve) or terminate (reject/withdraw);
  there is no transition into a terminal state's edit and no `Submitted →
  Approved` path. Enforced by the aggregate's per-source guards.
- **Optimistic concurrency** (`BR-INV-3`): every decision command supplies
  `expectedVersion`; a mismatch returns `STALE_STATE` (HTTP 409) with nothing
  written. The in-memory adapter also enforces the version+history append-only
  invariant defensively.
- **Event-per-transition** (`BR-INV-5`): each accepted transition publishes
  exactly one past-tense event to the `EventPublisher` port for the
  choreography consumers (audit-trail / notification / overlap-indicator).
- **Error → HTTP status mapping** (REST guide): `INVALID_INPUT`→422,
  `FORBIDDEN`→403, `NOT_FOUND`→404, `STALE_STATE`/`ILLEGAL_TRANSITION`→409,
  unauthenticated→401. All responses use the shared PII-free error envelope.
- **PII handling** (`req-nfr-security-pii`, `BR-INV-6`): error codes and event
  payloads carry only pseudonymous ids; free-text reason is never placed in a
  code or logged.
- **No new dependency.** Adopted the shipped TS/Node/Express/Vitest stack per
  `tech-stack-decisions`. The HTTP integration test uses Node's built-in `fetch`
  against an ephemeral `http.Server` rather than adding `supertest`.

## Test coverage

- **104 tests pass** (30 new for this unit): 10 aggregate + 15 service + 5 HTTP
  integration.
- Project-wide coverage after this unit: **96.34% lines / 83.95% branches /
  93.79% functions** — above the configured 80% / 75% thresholds; the coverage
  run exits 0.
- Verified clean: `npm run typecheck`, `npm run lint`, `npm test`.
- Cases cover happy two-stage path, lead/HR rejections, authz denials
  (permission + department scope), not-found, illegal-transition (HR on
  Submitted), stale-state concurrency race, input validation (`BR-VAL-1/2/3/4`),
  and owner-scoped withdraw.

## Composition note (not yet wired into `app.ts`)

The existing `src/app.ts` composes only the auth unit. `buildWorkflowRouter`
(exported from `src/workflow/index.ts`) is ready to be mounted alongside the
auth and authz surfaces in a future composition-root update; it expects an
`AuthService`, an `AuthzService`, and `CookieOptions`. The router relies on the
session pipeline attaching a `principalClaims` bag for claim-based role
resolution (the authz `defaultPrincipalResolver` contract); wiring that bag is
the composition-root's responsibility and is exercised via a stub in the
integration test. This was left as an integration point rather than editing
`app.ts` to avoid changing the shipped single-unit composition prematurely.

## Deviations from the plan

- Step 10's integration test uses built-in `fetch` + `http.Server` (matching the
  shipped `auth-router.test.ts` style) instead of a new test dependency.
- One service test's clock/date fixture was corrected during verification so the
  "date in the past" rule (`BR-VAL-3`) is exercised against a consistent
  injected clock.
