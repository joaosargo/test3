# Vacation Request App — Domain Entities — `unit-status-query`

Read-model value objects, projection shapes, and query-side types for the
**Status Tracking & Query** unit. Grounded in the `status-tracking` signatures of
[[component-methods]], the component boundaries in [[components]]
(`status-tracking → vacation-request-workflow`,
`status-tracking → authorization-rbac`), and the
`unit-status-query — Status Tracking and Query` definition in [[unit-of-work]].
The single owned story in [[unit-of-work-story-map]] (`story-status-tracking`)
and its requirement (`req-status-tracking` from [[requirements]]) drive the
shapes below. The unit sits on the pure **query path** per [[services]] — it
emits no events and owns no persisted state.

Design note: this unit **defines no entity and no aggregate**. Status tracking is
a read model; it introduces only **immutable projection value objects** and a
**query error**. It consumes, read-only:

- the `VacationRequest` aggregate and its `Transition` / `RequestStatus` /
  `WorkflowStage` / `DateRange` value objects from `unit-request-workflow`
  (`src/workflow/domain/`), via the `VacationRequestRepository` port;
- the `AuthenticatedPrincipal` / `PrincipalId` from `unit-platform-auth`
  (`src/domain/entities.ts`);
- the `AuthzGrant` / `Role` / `AuthzError` from `unit-platform-authz`
  (`src/authz/index.ts`).

It **redefines none of these** — keeping the customer–supplier boundaries clean
and avoiding duplicate identity, workflow, or RBAC models (the same discipline
`unit-request-workflow` and `unit-platform-authz` applied to their upstreams).

## Consumed Types (read-only, not owned here)

| Type | Owner unit | How this unit uses it |
|------|-----------|-----------------------|
| `VacationRequest` (aggregate) | `unit-request-workflow` | Source of projections; read accessors + `history` only, via the repository port. Never mutated. |
| `Transition { from, to, actorId, reason?, atMs }` | `unit-request-workflow` | Projected into `TimelineEntry`; the append-only history is the timeline. |
| `RequestStatus` (`Submitted`\|`Validated`\|`Approved`\|`Rejected`\|`Withdrawn`) | `unit-request-workflow` | Carried through projections and the optional status filter. |
| `WorkflowStage` (`TeamLead`\|`HR`) | `unit-request-workflow` | Surfaced as `TimelineEntry.stage` / `RequestSummaryView.rejectedStage`. |
| `DateRange { startDate, endDate }` | `unit-request-workflow` | Surfaced verbatim (ISO `YYYY-MM-DD`). |
| `AuthenticatedPrincipal` / `PrincipalId` | `unit-platform-auth` | The querying identity; `principalId` is the self-scope key. |
| `AuthzGrant { role, departmentScope }` | `unit-platform-authz` | The permit; `departmentScope` drives the defence-in-depth row filter (BR-SQ-5). |

## Projection Value Objects (owned here)

All projections are **immutable, identity-free** (DDD value-object semantics,
consistent with the shipped `LeaveBalance` / `Session` style). They are derived
per read and never persisted. They are **PII-lean by construction**: opaque ids
and department codes only; free-text `reason` is role-gated (BR-SQ-6).

### `RequestSummaryView`
The per-row shape of a list (`<MyRequestsList>` / lead + HR queues). Compact and
reason-free.

```ts
import type {
  RequestStatus,
  WorkflowStage,
  DateRange,
} from '../../workflow/domain/value-objects.js';
import type { RequestId } from '../../workflow/domain/value-objects.js';

/** One row in a status list. Reason text is never carried at summary level (BR-SQ-9). */
export interface RequestSummaryView {
  readonly id: RequestId;
  readonly status: RequestStatus;
  readonly dates: DateRange;
  /** `atMs` of the first (Submitted) transition. */
  readonly submittedAtMs: number;
  /** `atMs` of the latest transition — drives default list ordering (BR-SQ-10). */
  readonly lastUpdatedAtMs: number;
  /** Present only when `status === 'Rejected'` (mirrors the aggregate). */
  readonly rejectedStage?: WorkflowStage;
}
```

### `TimelineEntry`
One projected step of the append-only history. `reason` is present **only** when
the caller is entitled to it (BR-SQ-6); the field is omitted otherwise.

```ts
import type {
  RequestStatus,
  WorkflowStage,
} from '../../workflow/domain/value-objects.js';

/** A single projected transition in a request's timeline (chronological, BR-SQ-11). */
export interface TimelineEntry {
  /** Prior status; `null` for the initial submit. */
  readonly from: RequestStatus | null;
  readonly to: RequestStatus;
  /** Set on a rejection entry to attribute the stage. */
  readonly stage?: WorkflowStage;
  readonly atMs: number;
  /** Role-gated free-text note; omitted when the caller may not see it (BR-SQ-6). */
  readonly reason?: string;
}
```

### `RequestTimelineView`
The single-request detail: current status plus the full ordered timeline. The
"status across roles" surface (`req-status-tracking`).

```ts
import type {
  RequestId,
  RequestStatus,
  WorkflowStage,
  DateRange,
} from '../../workflow/domain/value-objects.js';
import type { TimelineEntry } from './timeline-entry.js';

/** One request's status + append-only timeline, projected and PII-lean. */
export interface RequestTimelineView {
  readonly id: RequestId;
  readonly status: RequestStatus;
  readonly dates: DateRange;
  /** Opaque department code (no name resolution here). */
  readonly department: string;
  readonly version: number;
  readonly rejectedStage?: WorkflowStage;
  /** Every accepted transition, `atMs` ascending (BR-SQ-11). */
  readonly timeline: readonly TimelineEntry[];
}
```

### `RequestStatusView` (lightweight single-status read)
A minimal current-status projection when the timeline is not needed (e.g. a
badge refresh). A strict subset of `RequestTimelineView` without the timeline.

```ts
import type {
  RequestId,
  RequestStatus,
  WorkflowStage,
} from '../../workflow/domain/value-objects.js';

/** Current status of one request, no history. */
export interface RequestStatusView {
  readonly id: RequestId;
  readonly status: RequestStatus;
  readonly rejectedStage?: WorkflowStage;
  readonly version: number;
}
```

## Query Types (owned here)

### `StatusQueryFilter`
The optional, validated query narrowing for list reads.

```ts
import type { RequestStatus } from '../../workflow/domain/value-objects.js';

/** Optional list narrowing. Absent `status` means "all visible statuses" (BR-SQ-12). */
export interface StatusQueryFilter {
  readonly status?: RequestStatus;
}
```

### `StatusQueryError` (value-level failure)
The read side's typed failure. PII-free, returned inside
`Result<T, StatusQueryError>` per the shipped `result.ts` convention — **never
thrown** (throwing reserved for misconfiguration), mirroring `WorkflowError` /
`AuthzError` / `SsoError`.

```ts
/** Machine-readable, PII-free status-query failure codes (BR-SQ-16). */
export type StatusQueryErrorCode =
  | 'INVALID_INPUT' // bad status filter / missing department or id (BR-SQ-12..14)
  | 'FORBIDDEN' // PDP denied the read (BR-SQ-1); echoes the authz reason
  | 'NOT_FOUND'; // no such request id, and not leaked to out-of-scope callers (BR-SQ-4)

/** Typed read-side error; static PII-free message. Mirrors WorkflowError shape. */
export class StatusQueryError extends Error {
  readonly code: StatusQueryErrorCode;
  readonly field?: string;
  /** Optional upstream authz deny reason echoed on FORBIDDEN. */
  readonly cause?: string;

  private constructor(code: StatusQueryErrorCode, message: string, field?: string, cause?: string) {
    super(message);
    this.name = 'StatusQueryError';
    this.code = code;
    if (field !== undefined) this.field = field;
    if (cause !== undefined) this.cause = cause;
    Object.setPrototypeOf(this, StatusQueryError.prototype);
  }

  static invalidInput(field: string): StatusQueryError {
    return new StatusQueryError('INVALID_INPUT', 'The query input was not valid.', field);
  }

  static forbidden(cause?: string): StatusQueryError {
    return new StatusQueryError('FORBIDDEN', 'You are not permitted to view this.', undefined, cause);
  }

  static notFound(): StatusQueryError {
    return new StatusQueryError('NOT_FOUND', 'The requested resource was not found.');
  }
}
```

## Ports (owned here)

This unit defines **no new persistence port** — it reads exclusively through the
`VacationRequestRepository` port already shipped by `unit-request-workflow`
(`findById`, `findByOwner`, `findByDepartmentAndStatus`). Reusing that port
(rather than defining a parallel read port) keeps a single anti-corruption seam
over the append-only store and guarantees the read model and command model see
the same rows. The only collaborator this unit *injects* is the shipped
`AuthzService` (via `src/authz/index.ts`) for the read authorization decision.

```ts
import type { AuthzService } from '../../authz/index.js';
import type { VacationRequestRepository } from '../../workflow/ports/vacation-request-repository.js';

/** Injected collaborators for the status-query service (hexagonal composition). */
export interface StatusQueryServiceDeps {
  readonly repo: VacationRequestRepository;
  readonly authz: AuthzService;
}
```

## Relationships & Lifecycle

```
AuthenticatedPrincipal (unit-platform-auth)
        │  principalId  (self-scope key)
        ▼
   StatusQueryService.<listOwnRequests | listScopedRequests | getRequestTimeline>
        │
   authz.decide(principal, view-permission, { department? })  ◄── unit-platform-authz
        │  AuthzGrant { role, departmentScope }
        ▼
   VacationRequestRepository  (findById | findByOwner | findByDepartmentAndStatus)  ◄── unit-request-workflow
        │  VacationRequest (read-only) + history: Transition[]
        ▼
   scope filter (BR-SQ-5) ──► project ──► RequestSummaryView[] | RequestTimelineView | RequestStatusView
```

Lifecycle: **none**. Projections are transient values created per read and
discarded after serialization — there is no stored read state, no state machine,
and no persistence to migrate (a stateless read that scales horizontally with no
affinity). Cross-unit references remain **ids, not object graphs**: this unit
returns view value objects keyed by `requestId`, never the `VacationRequest`
aggregate itself, preserving the least-coupling boundaries the upstream units
established.
