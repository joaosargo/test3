# Code Summary — `unit-status-query`

Code generation for the **Status Tracking & Query** unit — the CQRS Query half
of the vacation-request modular monolith. Implements `story-status-tracking`
(`req-status-tracking`): track a request's status and history across the
employee / team-lead / HR roles. The unit owns no state; it is a role-scoped,
read-only projection over the append-only `VacationRequest` history owned by
`unit-request-workflow`, authorized through the `unit-platform-authz` PDP.

## Files created

| File | Layer | Purpose |
|------|-------|---------|
| `src/status-query/domain/projections.ts` | Model | Immutable projection VOs: `RequestSummaryView`, `TimelineEntry`, `RequestTimelineView`, `RequestStatusView`, `StatusQueryFilter` (per domain-entities). |
| `src/status-query/domain/status-query-error.ts` | Model | `StatusQueryError` + `StatusQueryErrorCode` (`INVALID_INPUT` \| `FORBIDDEN` \| `NOT_FOUND`), PII-free, `Result`-returned (BR-SQ-16). |
| `src/status-query/services/status-query-service.ts` | Service | `StatusQueryService` — the three guarded reads: `listOwnRequests`, `listScopedRequests`, `getRequestTimeline`; `StatusQueryServiceDeps { repo, authz }`. |
| `src/status-query/http/status-query-router.ts` | Handler | Express router: 3 GET endpoints; maps `Result<_, StatusQueryError>` → shared PII-free envelope. |
| `src/status-query/index.ts` | Barrel | Public API surface (mirrors `src/workflow/index.ts`, `src/authz/index.ts`). |
| `src/status-query/services/status-query-service.test.ts` | Test | 13 service unit tests. |
| `src/status-query/http/status-query-router.test.ts` | Test | 6 HTTP integration tests. |

## Files modified

| File | Change |
|------|--------|
| `public/requests.html` | Brownfield in-place enhancement of the `my-requests-section`: added `<StatusFilterBar>`, `<RequestSummaryRow>` template, `<RequestTimelinePanel>` / `<TimelineEntryItem>` templates, and read-only client fetch wiring against the 3 GET endpoints. All interactive elements carry kebab-case `data-testid`. |

## Endpoints

| Method | Path | Service call | Server-enforced permission |
|--------|------|--------------|----------------------------|
| GET | `/status/requests` | `listOwnRequests` | `request:view-own` |
| GET | `/status/departments/:department/requests` | `listScopedRequests` | `request:view-team` (lead) or `request:view-department` (HR) |
| GET | `/status/requests/:id/timeline` | `getRequestTimeline` | resolved per caller relationship (own vs team/dept) |

Responses: list endpoints return `{ items: RequestSummaryView[] }`; the timeline
endpoint returns a `RequestTimelineView`. Failures use the shared envelope
`{ error: { code, message, field? } }` with the mapping `INVALID_INPUT → 422`,
`FORBIDDEN → 403`, `NOT_FOUND → 404`, unauthenticated `→ 401` — identical to the
`workflow-router` command side (frontend-components "API Integration Points").

## Key implementation decisions

1. **Authorization lives in the service, not the router middleware.** The
   mutating `workflow-router` binds one static permission per route via
   `requirePermission`. The status reads instead resolve the *least-privilege*
   permission from the caller's role / relationship to the resource
   (business-logic-model Query B/C, BR-SQ-2/3): owner → `view-own`; else
   `view-team`/`view-department` by role. So the router guards only
   `requireSession` and delegates the single fail-closed `AuthzService.decide`
   to `StatusQueryService`. This keeps the security boundary in one place and
   never trusts client-supplied scoping.
2. **No new persistence port or adapter.** The unit reads exclusively through
   the shipped `VacationRequestRepository` (`findById`, `findByOwner`,
   `findByDepartmentAndStatus`) — a single anti-corruption seam over the
   append-only store, guaranteeing the read model and command model see the
   same rows (domain-entities "Ports"; BR-SQ-8/17). No status column is
   maintained here; status is always the `to` of the latest transition.
3. **Reason role-gating by construction (BR-SQ-6).** Free-text `reason` is
   carried only in `RequestTimelineView` (never in `RequestSummaryView`, BR-SQ-9)
   and only for a caller already authorized for that request — an unauthorized
   caller never reaches projection. The client renders `reason` iff the server
   sent it (never inferring one).
4. **Defence-in-depth scope filter (BR-SQ-5).** After a permit, HR list results
   are re-filtered against `grant.departmentScope`; the filter only narrows,
   never widens. Team-lead scoping is applied by the PDP grant. Employee own-list
   re-asserts owner identity even though `findByOwner` already scopes.
5. **Deterministic server-defined ordering (BR-SQ-10).** Own-list + HR view sort
   by `lastUpdatedAtMs` desc; the team-lead work queue sorts by `submittedAtMs`
   asc (oldest-waiting first). Timeline is chronological `atMs` asc (BR-SQ-11).
6. **`app.ts` intentionally not modified.** The shipped convention is that each
   unit exports a `build*Router` consumed through its own tests; the composition
   root wires only auth today, and the dependency `unit-request-workflow` router
   is likewise not wired into `app.ts`. Following that convention avoids an
   inconsistent partial wiring; the router is exported from the unit barrel for
   the composition root to consume when the monolith's full HTTP surface is
   assembled.

## Test coverage summary

Active strategy: **Standard** (unit tests per component + integration test for
the HTTP boundary). 19 new tests, all passing:

- **Service (13)** — own-list happy path + ordering; reason-free summary rows;
  optional status filter; fail-closed `FORBIDDEN` on PDP deny; invalid status
  filter → `INVALID_INPUT`; HR department view scoped to grant; HR out-of-scope
  → `FORBIDDEN`; team-lead queue oldest-first; missing department →
  `INVALID_INPUT`; timeline chronological + owner reason (BR-SQ-6/11); unknown
  id → `NOT_FOUND`; in-scope HR non-owner read; out-of-scope non-owner →
  `FORBIDDEN`; empty id → `INVALID_INPUT`.
- **HTTP integration (6)** — 401 unauthenticated; 200 own-list; 422 bad status
  filter; 403 HR out-of-scope department; 200 owner timeline (chronological with
  reason); 404 unknown timeline id.

Verification: `npm run typecheck` (tsc `--noEmit`) exit 0; `npm run lint`
(eslint, `no-explicit-any: error`) exit 0; `npm test` (vitest) **123/123 tests
pass across 16 files** — 19 new, zero regressions in the dependency units. No
`dist/` build output left behind.

## Deviations from the plan

- **Step 7 (repository/data-access) and Step 10 (configuration)** were
  deliberate no-ops, as anticipated in the plan: the unit reuses the shipped
  repository port with no new adapter, and introduces no env vars, secrets, or
  build config (read-only, in-process, no new infrastructure footprint).
- **Step 9 (frontend tests)**: this repo has no browser/DOM test runner; the
  frontend behaviour is covered by the router integration test (the API contract
  the client consumes) plus the stable `data-testid` contract for future E2E
  automation. No new test dependency was added.
