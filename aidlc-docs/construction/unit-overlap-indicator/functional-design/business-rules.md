# Vacation Request App — Business Rules — `unit-overlap-indicator`

Decision rules, validation logic, constraints, and invariants for the **Overlap
Indicator** unit. These rules elaborate the `overlap-indicator` signature in
[[component-methods]], the `overlap-indicator → vacation-request-workflow`
boundary in [[components]], the side-effect (choreography) placement in
[[services]], and the `unit-overlap-indicator — Overlap Indicator` scope in
[[unit-of-work]]. Every rule serves the single story
`story-overlap-indicator` / requirement `req-overlap-indicator` from
[[requirements]] and its dependency on `story-lead-validate`
(per [[unit-of-work-story-map]]).

Rule id prefixes: `BR-OV-*` overlap computation, `BR-ADV-*` advisory posture,
`BR-PII-*` privacy, `BR-SCOPE-*` authorization scope.

## Overlap Computation Rules

- **BR-OV-1 — Intersection is the sole overlap test.** Two requests overlap iff
  their `DateRange`s intersect using the shipped inclusive-boundary primitive
  `rangesOverlap(a, b)` (`a.startDate <= b.endDate && b.startDate <= a.endDate`)
  from `unit-request-workflow`. No other similarity notion (adjacent days,
  same-week) counts as overlap.
- **BR-OV-2 — Same department only.** The comparison set is drawn only from the
  reviewed request's own `department`. Cross-department leave is out of scope for
  the indicator (open question in `memory.md`).
- **BR-OV-3 — Only competing statuses count.** Candidates must be in
  `Submitted`, `Validated`, or `Approved`. `Rejected` and `Withdrawn` requests
  are excluded because they reserve no coverage.
- **BR-OV-4 — No self-overlap.** The reviewed request never counts against
  itself; the candidate whose `id == reviewedRequest.id` is excluded.
- **BR-OV-5 — Count is a non-negative integer.** `overlapCount = |overlapping|`
  and `hasOverlap = overlapCount > 0`. These are derived purely from the
  comparison set — never stored, never cached as authoritative.
- **BR-OV-6 — Deterministic and idempotent.** For a fixed underlying request
  state, `computeOverlap` always returns the same summary and mutates nothing.

## Advisory-Posture Rules (the indicator is never a gate)

- **BR-ADV-1 — Read-only.** The unit performs no writes and emits no domain
  events. It calls only the read methods of `VacationRequestRepository`
  (`findById`, `findByDepartmentAndStatus`); it invokes no workflow transition
  verb.
- **BR-ADV-2 — Never blocks a decision.** An overlap (even a large count) does
  NOT prevent, delay, or require justification for a lead's validate/reject.
  Consistent with the `unit-request-workflow` business-logic-model — "overlap is
  a decision aid surfaced to approvers, not a submission gate"
  (`req-display-only-balance` posture, applied here to overlap).
- **BR-ADV-3 — Fail-open.** If the overlap read fails, the unit returns
  `err(OverlapError)` and the consuming UI degrades to "overlap unavailable".
  The failure MUST NOT propagate into or block the workflow command path.
- **BR-ADV-4 — No effect on audit or notifications.** Because it emits nothing,
  the indicator produces no audit facts (`audit-trail`) and triggers no
  notifications (`notification`); it is invisible to the immutable trail.

## Privacy Rules

- **BR-PII-1 — Counts and pseudonymous ids only.** The `OverlapSummary` carries
  `overlapCount`, `hasOverlap`, `overlappingIds` (opaque `RequestId`s), and the
  reviewed `window` — never subject names, emails, or free-text reasons
  (`req-nfr-security-pii`).
- **BR-PII-2 — No cross-principal leakage.** `overlappingIds` are opaque request
  identifiers, not owner identities; the badge reveals *that* overlap exists and
  *how much*, not *whose* leave, unless the viewing lead is already entitled to
  that data through the workflow/status surfaces.
- **BR-PII-3 — PII-free errors.** `OverlapError` messages carry a
  machine-readable code only, mirroring the `WorkflowError` / `AuthzError` /
  `SsoError` taxonomy convention.

## Authorization Scope Rules

- **BR-SCOPE-1 — Consumes authz, never re-derives it.** The overlap read runs
  behind the shared `requirePermission(authz, 'request:validate')` guard on the
  lead review path (`unit-platform-authz`). This unit makes no independent
  role/scope decision.
- **BR-SCOPE-2 — Department follows the reviewed request.** The comparison set's
  `department` is taken from the reviewed request the lead is already authorized
  to act on; the unit does not widen scope beyond that department.

## Validation & Edge Cases

| Case | Rule | Behaviour |
|------|------|-----------|
| Reviewed request not found | BR-ADV-3 | `err(OverlapError.notFound())`; UI shows "overlap unavailable" |
| Empty department (no other requests) | BR-OV-5 | `overlapCount = 0`, `hasOverlap = false` |
| Only rejected/withdrawn neighbours | BR-OV-3 | excluded; `overlapCount = 0` |
| Reviewed request itself in candidate set | BR-OV-4 | excluded from the count |
| Overlap read seam error | BR-ADV-3 | fail-open `err`; workflow decision unaffected |
| Non-lead viewer | BR-SCOPE-1 | `403` at the shared guard before any read |

## Invariants

- **INV-OV-1** — The unit owns no persistent state; every summary is recomputed
  from `unit-request-workflow`'s authoritative store (single source of truth).
- **INV-OV-2** — Nothing this unit does can change a `VacationRequest`'s status,
  history, or version (structural read-only guarantee).
- **INV-OV-3** — The overlap semantics equal the workflow's `DateRange`
  semantics because the same `rangesOverlap` primitive is reused, not copied.
