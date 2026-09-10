# Vacation Request App — Domain Entities — `unit-overlap-indicator`

Value objects, ports, and relationships for the **Overlap Indicator** unit.
Grounded in the `overlap-indicator` signature of [[component-methods]], the
`overlap-indicator → vacation-request-workflow` boundary in [[components]], the
read-side/choreography placement in [[services]], and the
`unit-overlap-indicator — Overlap Indicator` definition in [[unit-of-work]]. The
single owned story `story-overlap-indicator` and its requirement
`req-overlap-indicator` (from [[requirements]] and [[unit-of-work-story-map]])
drive the shapes below.

**Design note — this unit adds NO aggregate and NO persistence.** It is a pure
read-side projection. Identity, the `VacationRequest` aggregate, its `DateRange`
/ `RequestStatus` value objects, and the `rangesOverlap` primitive are all
**consumed read-only from `unit-request-workflow`** (`src/workflow/index.ts`) —
never redefined here. The unit contributes only two small value objects
(`OverlapSummary`, `OverlapError`) and one inbound read port, keeping the
boundary minimal and cohesive (least coupling; design-for-change).

## Consumed Types (read-only, from `unit-request-workflow`)

These are used as-is; this unit imports them and does not re-model them:

- `RequestId`, `DepartmentCode`, `RequestStatus` — identifiers and status enum.
- `DateRange` — the requested leave period (inclusive whole-day boundaries,
  `BR-VAL-3` upstream).
- `rangesOverlap(a: DateRange, b: DateRange): boolean` — the pure overlap
  primitive (the range math this unit depends on, defined upstream precisely so
  the indicator would not duplicate it).
- `VacationRequestRepository` (read methods `findById`,
  `findByDepartmentAndStatus`) — the anti-corruption read seam.

## Value Objects (owned by this unit)

All value objects are immutable; equality is by attribute value (DDD
value-object semantics), consistent with the shipped `LeaveBalance` / `Session`
style.

### `OverlapSummary`
The advisory result rendered as the team-lead badge.

| Attribute | Type | Notes |
|-----------|------|-------|
| `hasOverlap` | `boolean` | `true` iff `overlapCount > 0` (BR-OV-5). |
| `overlapCount` | `number` | Non-negative count of competing overlapping requests (BR-OV-5). |
| `overlappingIds` | `readonly RequestId[]` | Opaque ids of the overlapping requests — pseudonymous, PII-free (BR-PII-1/2). |
| `window` | `DateRange` | The reviewed request's range, echoed for the badge tooltip. |

Invariant: `overlapCount === overlappingIds.length` and
`hasOverlap === overlapCount > 0`. The summary is **derived, never persisted**
(INV-OV-1).

### `OverlapError` (value-level failure)
- `code`: `NOT_FOUND` | `READ_FAILED`.
  - `NOT_FOUND` — the reviewed request id resolves to nothing.
  - `READ_FAILED` — the repository read seam errored.
- PII-free message (code only), mirroring the shipped `WorkflowError` /
  `AuthzError` / `SsoError` / `HrisError` taxonomy. Returned inside
  `Result<OverlapSummary, OverlapError>` per `src/domain/result.ts`, **not
  thrown** (throwing reserved for misconfiguration). Treated by callers as
  fail-open advisory (BR-ADV-3).

### `OverlapQuery` (optional input value object)
The `computeOverlap` input when the caller passes explicit context rather than a
bare `requestId`:

| Attribute | Type | Notes |
|-----------|------|-------|
| `department` | `DepartmentCode` | Scope key; follows the reviewed request (BR-SCOPE-2). |
| `dates` | `DateRange` | The range to test against the department's competing requests. |
| `selfRequestId` | `RequestId?` | Excluded from the count to prevent self-overlap (BR-OV-4). |

## Ports (owned by this unit)

### `OverlapReader` (inbound / driving port)
The single capability the unit exposes (matches [[component-methods]]
`overlap-indicator`):

```
interface OverlapReader {
  // Compute the advisory overlap summary for a request under review.
  computeOverlap(requestId: RequestId): Promise<Result<OverlapSummary, OverlapError>>;
}
```

There is **no outbound port unique to this unit** — its only outbound dependency
is the *consumed* `VacationRequestRepository` read seam owned by
`unit-request-workflow`. The unit deliberately holds no repository, no cache, and
no event publisher of its own (contrast the command-path units), reflecting its
stateless read-side nature (per [[services]]).

## Relationships & Lifecycle

```
Team lead reviewing a Submitted request  (persona: team-lead, story-overlap-indicator)
        │  requireSession → requirePermission('request:validate')   ◄── unit-platform-authz (read-only)
        ▼
   OverlapReader.computeOverlap(requestId)
        │
        ├─► workflow.findById(requestId)                     ◄── unit-request-workflow (read-only)
        │        └─ R = { department, dates, status, ... }
        │
        ├─► workflow.findByDepartmentAndStatus(R.department, {Submitted,Validated,Approved})
        │        └─ candidates[]                             ◄── unit-request-workflow (read-only)
        │
        └─► filter: c.id != R.id ∧ rangesOverlap(R.dates, c.dates)   [reuses upstream primitive]
                 └─► OverlapSummary { hasOverlap, overlapCount, overlappingIds, window }
                          └─► rendered as <OverlapIndicatorBadge> on <RequestReviewCard>
```

Lifecycle: **there is none to persist.** `OverlapSummary` is a transient
computed value with request-response lifetime; it is created on each read and
discarded after rendering. No entity in this unit has a stored state machine —
all durable state lives in `unit-request-workflow`.

Cross-unit references use **ids, not object graphs** (least coupling): the
summary exposes `RequestId`s only, and the unit reaches the workflow exclusively
through its published `src/workflow/index.ts` read surface — never its
internals — preserving the boundary the workflow unit's `domain-entities`
established.
