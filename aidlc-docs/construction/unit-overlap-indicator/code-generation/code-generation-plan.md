# Code Generation Plan — `unit-overlap-indicator`

Scope: the single story `story-overlap-indicator` ("Team lead sees an overlap
indicator", *should-have*, persona `team-lead`, depends on `story-lead-validate`)
covering requirement `req-overlap-indicator`, per [[unit-of-work]] and
[[requirements]]. This unit is a pure, stateless read-side projection that
depends on `unit-request-workflow` (already completed) and owns no persistence.

Grounded in the unit's functional-design (`business-logic-model`,
`business-rules`, `domain-entities`, `frontend-components`) and nfr-design
(`performance-design`, `security-design`, `reliability-design`,
`scalability-design`). Reuses the shipped `rangesOverlap` primitive and the
`VacationRequestRepository` read seam exported from `src/workflow/index.ts`
(INV-OV-3), consumes the `requireSession → requirePermission('request:validate')`
pipeline from `unit-platform-auth` + `unit-platform-authz`, and follows the
`Result<T, E>` convention from `src/domain/result.ts`.

Test strategy: **standard** — unit test files per component (5–8 tests) plus an
integration test at the HTTP boundary. Existing `vitest.config.ts` /
`.eslintrc.cjs` / `tsconfig.json` are reused (no new test config needed).

Layer-by-layer ordering (dependencies before dependents). Story traceability in
the right-hand column.

| Step | Description | Files | Story / Rule |
|------|-------------|-------|--------------|
| Step 1 | Project structure — new `src/overlap/` module (domain/ ports/ services/ http/ + index.ts), mirroring the sibling unit layout. No new package deps. | `src/overlap/**` | story-overlap-indicator |
| Step 2 | Domain value objects — `OverlapSummary`, `OverlapQuery`, `COMPETING_STATUSES`; consume `DateRange`/`RequestId`/`RequestStatus`/`rangesOverlap` read-only from `src/workflow/index.ts`. | `src/overlap/domain/value-objects.ts` | BR-OV-3/5, BR-PII-1, domain-entities |
| Step 3 | Domain error — PII-free `OverlapError` (`NOT_FOUND` / `READ_FAILED`) mirroring `WorkflowError`/`AuthzError`. | `src/overlap/domain/overlap-error.ts` | BR-PII-3, BR-ADV-3 |
| Step 4 | Inbound port — `OverlapReader.computeOverlap`. | `src/overlap/ports/overlap-reader.ts` | domain-entities, component-methods |
| Step 5 | Business logic — `OverlapService` (pure projection: findById → gather competing candidates → filter self + rangesOverlap → summary; fail-open on read fault). | `src/overlap/services/overlap-service.ts` | BR-OV-1..6, BR-ADV-1/3, BR-SCOPE-2 |
| Step 6 | Business logic tests — 8 unit tests (overlap present, none, rejected/withdrawn excluded, self-exclusion, PII-free shape, not-found, fail-open, department scope). | `src/overlap/services/overlap-service.test.ts` | BR-OV-1..6, BR-PII-1/2, BR-ADV-3 |
| Step 7 | API layer — guarded `GET /requests/:id/overlap` router reusing `requireSession → requirePermission('request:validate')`; PII-free error envelope; 200 / 401 / 403 / 404 / 503. | `src/overlap/http/overlap-router.ts` | story-overlap-indicator, BR-SCOPE-1 |
| Step 8 | API tests — 4 integration tests over an ephemeral http.Server (200 summary, 401 unauth, 403 non-lead, 404 unknown). | `src/overlap/http/overlap-router.test.ts` | BR-SCOPE-1, BR-ADV-3 |
| Step 9 | Composition surface — `src/overlap/index.ts` public exports + `createOverlapService` / `mountOverlapRoutes` helpers (in-process mount, mirrors `hris` unit). | `src/overlap/index.ts` | deployment-architecture (in-process) |
| Step 10 | Frontend — framework-free `public/overlap-badge.js` (`fetchOverlapSummary` + `renderOverlapBadge` + `mountOverlapBadge`) targeting the reserved `overlap-indicator-badge` testid on `<RequestReviewCard>`; advisory, fail-open, PII-free. | `public/overlap-badge.js` | story-overlap-indicator, BR-ADV-2/3, BR-PII-1 |
| Step 11 | Test configuration — reuse existing `vitest.config.ts` (glob already covers `src/**/*.test.ts`); no change required. | (none) | — |
| Step 12 | Documentation — inline TSDoc on every file tracing to rules/stories; this plan + code-summary. | inline | — |

## Verification checklist

- [x] Step 1 — module scaffold created
- [x] Step 2 — value objects
- [x] Step 3 — OverlapError
- [x] Step 4 — OverlapReader port
- [x] Step 5 — OverlapService
- [x] Step 6 — service unit tests (8)
- [x] Step 7 — overlap-router
- [x] Step 8 — router integration tests (4)
- [x] Step 9 — index.ts composition helpers
- [x] Step 10 — public/overlap-badge.js
- [x] Step 11 — test config (reused, no change)
- [x] Step 12 — inline docs + artifacts
- [x] `npm run typecheck` — passes
- [x] `npm run lint` — passes
- [x] `npm test` — 116/116 pass (12 new, no regressions)

## Deliberate non-changes

- **No edit to `app.ts` / `server.ts`.** The sibling units (`workflow`, `authz`,
  `hris`) each ship a mount helper and are not yet wired into the production
  composition root; this unit follows that established pattern
  (`mountOverlapRoutes` is exported for the later integration stage) rather than
  introducing an inconsistent wiring.
- **No new repository method upstream.** `computeOverlap` reuses
  `findByDepartmentAndStatus` once per competing status instead of widening the
  dependency unit's port (least coupling; off the command hot path per
  performance-design).
