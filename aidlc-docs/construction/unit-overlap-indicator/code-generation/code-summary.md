# Code Summary — `unit-overlap-indicator`

Implementation of the **Overlap Indicator** — a lightweight, read-only decision
aid that tells a reviewing team lead how many other in-scope team requests
overlap a request's dates. Realizes `story-overlap-indicator` /
`req-overlap-indicator` (per [[unit-of-work]] and [[requirements]]), depending
on the already-completed `unit-request-workflow`. Grounded in the unit's
`business-logic-model`, `business-rules`, `domain-entities`, and
`frontend-components` functional-design artifacts, and its `performance-design`
/ `security-design` nfr-design.

## Files created

| File | Kind | Responsibility |
|------|------|----------------|
| `src/overlap/domain/value-objects.ts` | Value objects | `OverlapSummary`, `OverlapQuery`, `COMPETING_STATUSES`; consumes `DateRange`/`RequestId`/`rangesOverlap` read-only from `src/workflow/index.ts` (INV-OV-3). |
| `src/overlap/domain/overlap-error.ts` | Error taxonomy | PII-free `OverlapError` (`NOT_FOUND` / `READ_FAILED`), mirrors `WorkflowError`/`AuthzError`/`SsoError` (BR-PII-3). |
| `src/overlap/ports/overlap-reader.ts` | Inbound port | `OverlapReader.computeOverlap` — the unit's single capability. |
| `src/overlap/services/overlap-service.ts` | Service | Pure, stateless projection: `findById` → gather competing candidates → filter self + `rangesOverlap` → summary; fail-open on read fault. |
| `src/overlap/services/overlap-service.test.ts` | Unit tests | 8 tests: overlap present, none, rejected/withdrawn excluded, self-exclusion, PII-free shape, not-found, fail-open, department scope. |
| `src/overlap/http/overlap-router.ts` | HTTP router | Guarded `GET /requests/:id/overlap` reusing `requireSession → requirePermission('request:validate')`. |
| `src/overlap/http/overlap-router.test.ts` | Integration tests | 4 tests: 200 summary, 401 unauth, 403 non-lead, 404 unknown. |
| `src/overlap/index.ts` | Public API | Exports + `createOverlapService` / `mountOverlapRoutes` in-process composition helpers (mirrors `src/hris/hris-balance.ts`). |
| `public/overlap-badge.js` | Frontend | Framework-free `fetchOverlapSummary` / `renderOverlapBadge` / `mountOverlapBadge` for the reserved `overlap-indicator-badge` slot; advisory, fail-open, PII-free. |

## Files modified

None. The reserved `[data-testid="overlap-indicator-badge"]` slot already exists
in the `unit-request-workflow`-owned `public/requests.html`; this unit populates
it via the new client helper without altering the host card markup.

## Key implementation decisions

- **Pure read-side projection, zero new persistence (INV-OV-1).** The service
  holds only a reference to the workflow's `VacationRequestRepository` and owns
  no repository, cache, or event publisher — consistent with `domain-entities`
  and the choreography/read-side placement.
- **Reuse over re-derivation (INV-OV-3).** Overlap is computed with the shipped
  `rangesOverlap` primitive and the `DateRange`/`RequestStatus` value objects
  imported from `src/workflow/index.ts`; no date math is duplicated.
- **Fail-open, advisory-only (BR-ADV-1/2/3).** No writes, no emitted events, no
  transition verbs. Read-seam faults are caught and returned as
  `err(READ_FAILED)`; the client renders a neutral "overlap unavailable" chip
  and never gates the Validate/Reject controls.
- **Authorization consumed, never re-derived (BR-SCOPE-1/2).** The endpoint sits
  behind the exact `request:validate` pipeline that guards the lead review
  action; the comparison set's department follows the reviewed request.
- **PII-free by construction (BR-PII-1..3).** `OverlapSummary` carries counts,
  opaque `RequestId`s, and the reviewed window only; errors carry a
  machine-readable code only.
- **Competing statuses only (BR-OV-3).** Candidates are drawn from `Submitted`,
  `Validated`, `Approved`; `Rejected` / `Withdrawn` are excluded. Implemented as
  one scoped `findByDepartmentAndStatus` read per status to avoid widening the
  dependency unit's port.

## Test coverage summary

- 12 new tests (8 service unit + 4 HTTP integration), all passing.
- Full suite: **116/116 passing** — the 104 pre-existing tests still pass (no
  regressions introduced).
- Coverage for the new module: `overlap/domain` 100%, `overlap/http` ~97%; the
  service is exercised through both suites.
- `npm run typecheck` and `npm run lint` both pass clean.

## Deviations from the plan

None functional. Two deliberate non-changes (documented in the plan): `app.ts` /
`server.ts` are left unwired (following the sibling units' mount-helper pattern
for a later integration stage), and no new upstream repository method was added.

## Note on artifact recording

The MCP `create_artifact` tool specified by the execution environment was not
available in this session, so this summary and the code-generation-plan were
written to the conventional on-disk path
(`aidlc-docs/construction/unit-overlap-indicator/code-generation/`). All source
code was written to the working tree and verified as required.
