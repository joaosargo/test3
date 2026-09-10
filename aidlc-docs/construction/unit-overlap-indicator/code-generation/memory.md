<!-- Stage diary — code-generation / unit-overlap-indicator -->

## Interpretations
- 2026-09-10T14:17:00Z — placed the unit under `src/overlap/` mirroring the sibling module layout (`src/workflow/`, `src/authz/`, `src/hris/`): domain/ ports/ services/ http/ + index.ts. The overlap unit is a pure read-side projection so it owns only value objects (OverlapSummary, OverlapError), one inbound port (OverlapReader), a service, and a guarded read router; it holds no repository, cache, or event publisher (per domain-entities).
- 2026-09-10T14:17:00Z — the service consumes `unit-request-workflow`'s published `VacationRequestRepository` read seam (`findById`, `findByDepartmentAndStatus`) and the `rangesOverlap` primitive via `src/workflow/index.js` only — never workflow internals (INV-OV-3, least coupling).
- 2026-09-10T14:17:00Z — the GET /requests/:id/overlap endpoint is guarded by the SAME requireSession -> requirePermission('request:validate') pipeline as the lead review action (BR-SCOPE-1); the unit performs no independent authz decision.

## Deviations
- 2026-09-10T14:17:00Z — frontend badge: `public/requests.html` already reserves the `overlap-indicator-badge` data-testid slot (owned by the host card from unit-request-workflow). Rather than duplicate the whole page, this unit adds a small standalone `public/overlap-badge.js` client helper (fetch + fail-open render) that the lead queue wiring can call, keeping the badge logic in this unit's lane without editing the workflow-owned card markup structure.

## Tradeoffs
- 2026-09-10T14:17:00Z — computeOverlap issues three read calls (one per competing status) against findByDepartmentAndStatus rather than adding a new multi-status repository method upstream — reusing the shipped read seam verbatim avoids widening the dependency unit's port (design-for-change; the perf-design confirms this is off the command hot path).

## Open questions
- 2026-09-10T14:17:00Z — cross-department overlap is explicitly out of scope (BR-OV-2); confirm if a future story widens the comparison set beyond the reviewed request's department.
