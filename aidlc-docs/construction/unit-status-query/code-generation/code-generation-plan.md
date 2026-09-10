# Code Generation Plan — `unit-status-query`

Read/query side (CQRS Query half) of the vacation-request modular monolith:
the **Status Tracking & Query** unit. Owns no state — a role-scoped, read-only
projection over the append-only `VacationRequest` history that
`unit-request-workflow` owns, authorized through the `unit-platform-authz` PDP.

## Story & requirement traceability

This unit is scoped to a single story per the `unit-of-work` /
`unit-of-work-story-map`:

| Story | Requirement | Persona | Plan steps that implement it |
|-------|-------------|---------|------------------------------|
| `story-status-tracking` — Track request status across roles | `req-status-tracking` | employee (also surfaced to team-lead + hr) | Steps 2–9 |

Dependency units consumed **read-only**: `unit-request-workflow`
(`VacationRequestRepository` port + `VacationRequest` aggregate) and
`unit-platform-authz` (`AuthzService.decide`). This unit modifies neither.

Design inputs consumed: `business-logic-model`, `domain-entities`,
`business-rules`, `frontend-components` (functional-design); `performance-design`,
`security-design` (nfr-design); `unit-of-work`; `requirements`.

## Conventions locked from the shipped codebase (brownfield)

- Feature-folder layout under `src/status-query/` mirroring `src/workflow/`,
  `src/authz/`, `src/hris/` (`domain/`, `services/`, `http/`, `index.ts`).
- `Result<T,E>` value returns (`src/domain/result.ts`); never throw for expected
  failures. PII-free error codes + shared HTTP envelope `{ error: { code,
  message, field? } }`.
- HTTP status map: `INVALID_INPUT → 422`, `FORBIDDEN → 403`, `NOT_FOUND → 404`,
  unauthenticated `→ 401` — identical to `workflow-router.ts`.
- Router pipeline `requireSession → requirePermission(authz, perm) → handler`.
- ESM `.js` import specifiers; `strict` tsc; eslint `no-explicit-any: error`.
- vitest; tests co-located as `*.test.ts`.

## Steps

- [ ] **Step 1: Project structure setup.** Create `src/status-query/` with
  `domain/`, `services/`, `http/` subfolders. No new npm dependencies (reuses
  express/vitest already present). *(story-status-tracking scaffolding)*
- [ ] **Step 2: Data models / projection value objects.**
  `src/status-query/domain/projections.ts` — `RequestSummaryView`,
  `TimelineEntry`, `RequestTimelineView`, `RequestStatusView`,
  `StatusQueryFilter` (immutable, PII-lean; consume workflow value-objects
  read-only). `src/status-query/domain/status-query-error.ts` —
  `StatusQueryError` + `StatusQueryErrorCode` (`INVALID_INPUT | FORBIDDEN |
  NOT_FOUND`). *(domain-entities; BR-SQ-9/12/16)*
- [ ] **Step 3: Business logic layer — `StatusQueryService`.**
  `src/status-query/services/status-query-service.ts` with
  `StatusQueryServiceDeps { repo, authz }` and the three read capabilities:
  `listOwnRequests`, `listScopedRequests`, `getRequestTimeline`. Each is an
  ordered fail-closed authorized read (BR-SQ-1..8), projection + ordering
  (BR-SQ-9..11), input validation (BR-SQ-12..14), reason role-gating (BR-SQ-6).
  *(business-logic-model Query Flows A/B/C)*
- [ ] **Step 4: Business logic tests.**
  `src/status-query/services/status-query-service.test.ts` — happy paths + the
  fail-closed / scope / PII edge cases (Standard strategy, 5–8 tests).
- [ ] **Step 5: API / endpoint layer — status-query router.**
  `src/status-query/http/status-query-router.ts` — 3 GET endpoints
  (`/status/requests`, `/status/departments/:department/requests`,
  `/status/requests/:id/timeline`), each guarded and mapping the
  `Result<_, StatusQueryError>` to the shared envelope. *(frontend-components API
  Integration Points; REST guide)*
- [ ] **Step 6: API tests.**
  `src/status-query/http/status-query-router.test.ts` — integration test over an
  ephemeral `http.Server` covering 200 / 401 / 403 / 404 / 422 (mirrors
  `workflow-router.test.ts`).
- [ ] **Step 7: Repository / data-access layer.** None owned — reuses the
  shipped `VacationRequestRepository` port (no new adapter). Documented as a
  deliberate no-op in the summary. *(domain-entities "Ports" section)*
- [ ] **Step 8: Frontend components.** Add the read-only **status surface** to
  `public/requests.html` — `<StatusFilterBar>`, `<RequestTimelinePanel>` /
  `<TimelineEntryItem>` markup + client fetch wiring against the 3 GET
  endpoints, with `data-testid` attributes. *(frontend-components hierarchy)*
- [ ] **Step 9: Frontend interaction wiring / tests.** Client script that loads
  `GET /status/requests` and lazy-loads timelines on expand; `data-testid`
  hooks for automation. (No separate JS test runner in this repo — behaviour is
  covered by the router integration test + DOM `data-testid` contract.)
- [ ] **Step 10: Configuration and environment setup.** None — no new env vars,
  secrets, or build config (read-only, in-process, no new infra per
  `deployment-architecture-unit-overlap-indicator`-class posture).
- [ ] **Step 11: Test configuration.** Reuse existing `vitest.config.ts` — new
  `*.test.ts` files are auto-discovered; no change required.
- [ ] **Step 12: Documentation.** Inline JSDoc on every module (matching the
  shipped house style) + `code-summary.md`.

## Test plan (Standard strategy)

- `status-query-service.test.ts`: listOwnRequests happy path + ordering;
  forbidden (PDP deny) fail-closed; scoped queue for HR with department filter;
  getRequestTimeline happy path + notFound + reason role-gating (owner sees
  reason, out-of-scope omitted); invalid status filter → INVALID_INPUT.
- `status-query-router.test.ts`: 200 own-list, 401 unauthenticated, 403
  forbidden, 404 unknown timeline id, 422 bad status filter.
