# Vacation Request App — Business Logic Model — `unit-overlap-indicator`

Functional design for the **Overlap Indicator** unit — a lightweight, read-only
**decision aid** that tells a team lead, while reviewing a pending request,
whether the requested dates overlap with other team members' leave. Scope is the
single story the [[unit-of-work-story-map]] assigns to this unit,
`story-overlap-indicator` ("Team lead sees an overlap indicator", *should-have*,
persona `team-lead`, depends on `story-lead-validate`), covering the single
requirement `req-overlap-indicator` ("Lightweight overlap indicator for team
lead") from [[requirements]].

Per the [[unit-of-work]] `unit-overlap-indicator — Overlap Indicator`
definition, this unit **depends on `unit-request-workflow`** and owns no
workflow state of its own. The [[components]] architecture places
`overlap-indicator → vacation-request-workflow`; the [[services]] artifact puts
overlap on the **choreography / side-effect side**, not on the synchronous
command path — it consumes what the workflow owns and never writes back. The
public method shape is fixed by the `overlap-indicator` section of
[[component-methods]] and this model elaborates it.

## Design Approach

The overlap indicator is a **pure, stateless projection** over data the
`unit-request-workflow` unit already owns. It introduces **no new aggregate and
no new persistence** (see `domain-entities`): it reads the department's requests
through the workflow's `VacationRequestRepository` read seam
(`findByDepartmentAndStatus`) and computes an overlap summary using the shipped
pure primitive `rangesOverlap(a, b)` from `src/workflow/domain/value-objects.ts`.
Reusing that primitive — rather than re-deriving date math — keeps the boundary
clean (least coupling) and guarantees the overlap semantics match the workflow's
`DateRange` invariants (inclusive whole-day boundaries, `BR-VAL-3`).

The unit is **advisory-only and fail-open on its own errors** (see
`business-rules`): it never blocks, gates, or mutates a workflow transition. Per
the `unit-request-workflow` business-logic-model, "balance and overlap are
decision aids surfaced to approvers, not submission gates." If the overlap query
fails, the reviewing UI degrades to "overlap unavailable" and the lead may still
validate or reject — the workflow command path is entirely independent of this
unit.

Authorization is **not re-derived** here. The unit is invoked only behind the
same `requireSession → requirePermission('request:validate')` pipeline that
guards the lead's review screen (consuming `unit-platform-authz` verbatim). The
overlap query is scoped to the department the authz layer already authorized the
lead to act on; this unit passes the request's `department` through and performs
no independent scope decision (consistent with the authz `frontend-components`
"server-authoritative" contract).

Error handling follows the shipped `Result<T, E>` convention
(`src/domain/result.ts`): an expected read failure is returned as
`Result.err(OverlapError)` with a PII-free code, never thrown. PII rules
(`req-nfr-security-pii`): the overlap summary carries **counts and pseudonymous
request ids only** — never subject names, emails, or free-text reasons.

The unit exposes one cohesive capability, matching [[component-methods]]:

1. **Compute overlap** — given a request under review (or its dates +
   department), return a summary of how many other in-scope team requests
   overlap the requested range, with just enough detail to render a badge.

## Overlap Computation

### Definition of "overlap"

Two requests overlap when their `DateRange`s intersect on the calendar, using the
same inclusive-boundary rule as the workflow unit:

```
overlaps(a, b)  ≡  a.startDate <= b.endDate  AND  b.startDate <= a.endDate
```

This is exactly `rangesOverlap` shipped in `unit-request-workflow`; the unit
imports it and does not reimplement it.

### The comparison set

For a request `R` under review with department `D` and range `R.dates`, the
comparison set is every **other** request in department `D` whose status
competes for team coverage:

- Included statuses: `Submitted`, `Validated`, `Approved` — these represent live
  or committed leave that actually reduces team availability.
- Excluded statuses: `Rejected`, `Withdrawn` — terminal-negative, they free no
  one and compete with nothing (`business-rules` BR-OV-3).
- Excluded: `R` itself (`requestId == R.id`) — a request never overlaps itself
  (BR-OV-4).

### Algorithm — `computeOverlap`

Input: the request under review (by `requestId`, or an explicit
`{ department, dates, selfRequestId? }`). Output:
`Result<OverlapSummary, OverlapError>`.

```
computeOverlap(principal, requestId):
  1. load R = workflow.findById(requestId)
        not found        → err(OverlapError.notFound())          [advisory: caller ignores]
  2. gather candidates for department R.department across the
     competing statuses (Submitted, Validated, Approved):
        candidates = ⋃ status ∈ {Submitted,Validated,Approved}
                       workflow.findByDepartmentAndStatus(R.department, status)
        (read-only; no write, no event emitted)
  3. overlapping = [ c ∈ candidates
                       where c.id != R.id
                       and rangesOverlap(R.dates, c.dates) ]        [BR-OV-1..4]
  4. build OverlapSummary:
        overlapCount   = overlapping.length
        hasOverlap     = overlapCount > 0
        overlappingIds = overlapping.map(c => c.id)                 [pseudonymous ids only]
        window         = R.dates                                    [echoed for the badge tooltip]
  5. return ok(summary)                                             [PII-free, BR-OV-6]
```

The method is **idempotent and side-effect-free** — calling it any number of
times produces the same summary for the same underlying state and changes
nothing. There is no persistence step and no event emission (contrast the
command-path workflows in `unit-request-workflow`).

## Data Flow & Integration Points

- **Inbound (from the lead review UI / `unit-platform-auth` +
  `unit-platform-authz`)**: the overlap summary is requested behind the same
  guarded pipeline as the lead's `request:validate` review action —
  `requireSession(...)` → `requirePermission(authz, 'request:validate')` →
  overlap read. The reviewing screen (`<RequestReviewCard>` in the
  `unit-request-workflow` `frontend-components`) renders the badge from the
  returned summary.
- **To `unit-request-workflow` (dependency, read-only)**: the unit consumes the
  shipped `VacationRequestRepository` read methods (`findById`,
  `findByDepartmentAndStatus`) and the `rangesOverlap` / `DateRange` /
  `RequestStatus` value objects exported from `src/workflow/index.ts`. It calls
  **no mutating** workflow method and holds **no reference** to the aggregate's
  transition verbs.
- **No outbound events, no writes.** Unlike the command-path units, this unit
  publishes nothing to the choreography bus and persists nothing; it is a pure
  consumer on the read side (per [[services]]).
- **Failure isolation.** Because the workflow command path never calls this unit,
  an overlap-read failure cannot block a validate/reject/approve. The UI treats a
  missing/failed summary as "overlap unavailable" (advisory degrade), preserving
  the workflow's independence.

## Business Scenarios

1. **Overlap present (happy advisory path).** Lead opens a `Submitted` request for
   2 team members already on leave in the window → `computeOverlap` returns
   `overlapCount = 2`, `hasOverlap = true` → the review card shows an amber
   "2 overlapping" badge; the lead still decides freely.
2. **No overlap.** No other competing request intersects the window →
   `overlapCount = 0`, `hasOverlap = false` → neutral "no overlap" badge.
3. **Rejected/withdrawn are ignored.** A previously rejected request in the same
   window is NOT counted (BR-OV-3) — the badge reflects only live/approved leave.
4. **Overlap query fails (fail-open).** The read seam errors →
   `err(OverlapError)` → UI shows "overlap unavailable"; the Validate/Reject
   controls remain fully enabled (advisory-only, never a gate).
5. **Unauthorized viewer.** A non-lead who reaches the endpoint is stopped by the
   shared `requirePermission('request:validate')` guard with `403` before any
   overlap read runs — this unit performs no independent authorization.
