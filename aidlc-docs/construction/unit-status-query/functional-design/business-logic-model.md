# Vacation Request App — Business Logic Model — `unit-status-query`

Functional design for the **Status Tracking & Query** unit — the **read/query
side** of the vacation-request modular monolith. This unit answers a single
question for three different audiences: *"what is happening with this request (or
these requests), and how did it get here?"* It owns **no state of its own**. It
is a role-scoped, read-only projection over the append-only `VacationRequest`
history that `unit-request-workflow` owns, authorized through the
`unit-platform-authz` PDP.

Scope is bound to the single story the [[unit-of-work-story-map]] assigns to
`unit-status-query`:

- `story-status-tracking` — Track request status across roles (covers
  `req-status-tracking`; persona `employee`; depends on `story-submit-request`).

That requirement id and the "status visible across roles" shape are defined in
[[requirements]] (functional-requirements section). Per the [[unit-of-work]]
`unit-status-query — Status Tracking and Query` definition, this unit depends on
`unit-request-workflow` (the read model source) and `unit-platform-authz` (the
authorization decision), and it is not itself consumed by other units on the
command path. The [[components]] architecture places `status-tracking` with the
declared dependencies `status-tracking → vacation-request-workflow` and
`status-tracking → authorization-rbac`; the [[services]] artifact places reads
on the query path (no side effects, no events emitted). The public method shapes
are fixed by the `status-tracking` section of [[component-methods]] and are the
contract this model elaborates.

## Design Approach

This unit is deliberately a **CQRS read model** (Query Responsibility half): it
is separated from the command side so a read that scans an employee's history or
a lead's queue never contends with, or accidentally mutates, the aggregate the
command path guards. Because the vacation domain is small and strongly
consistent (one lead, then one HR approver per request), the read model is **not
a separate eventually-consistent store** — it is a **synchronous projection
computed on demand** from the same append-only history via the shipped
`VacationRequestRepository` port (`findById`, `findByOwner`,
`findByDepartmentAndStatus`). This keeps status always consistent with the last
accepted transition (the `to` of the latest `Transition`) and avoids the
replication-lag and rebuild complexity a denormalized read store would add for no
benefit at this scale. If read volume ever diverges from write volume, the same
port seam allows swapping in a materialized projection later without changing
this unit's public surface (design-for-change, not premature optimization).

Every query is a **guarded read**. The guard has two halves, mirroring the
command side established by `unit-request-workflow`:

1. **Authorization — the *who-may-see* half — delegated to the PDP.** This unit
   never re-derives roles or department scope. It calls
   `AuthzService.decide(principal, permission, resource)` with the *view*
   permission appropriate to the query shape and treats the returned
   `AuthzGrant { role, departmentScope }` as authoritative, consistent with
   `src/authz/index.ts` and the authz `business-rules` (`BR-AUTHZ-*`). The three
   view permissions come straight from the shipped closed permission set:
   `request:view-own` (employee), `request:view-team` (team-lead),
   `request:view-department` (HR).
2. **Scope filtering — the *which-rows* half — applied here.** After a permit,
   this unit filters the candidate rows to exactly the set the grant allows:
   an employee sees only requests where `ownerId == principal.principalId`; a
   team lead sees their own team's requests; an HR approver sees requests whose
   `department` falls within `grant.departmentScope`. Rows outside scope are
   **omitted, never denied with a leak** — a scoped list simply does not contain
   them.

Error handling follows the shipped `Result<T, E>` convention
(`src/domain/result.ts`): expected read failures (authorization denial, unknown
id, invalid query input) are returned as `Result.err` values carrying a
machine-readable, PII-free code — never thrown. Throwing is reserved for
programmer error / misconfiguration, exactly as in the auth, authz, and workflow
units. PII (principal identifiers, free-text reasons) is redacted at every log
boundary per `req-nfr-security-pii`; the projection returned to a caller carries
only what that caller is authorized to see.

The unit exposes three cohesive read capabilities, matching the `status-tracking`
signatures in [[component-methods]]:

1. **List my requests** — an employee's own request summaries.
2. **List a scoped queue / department view** — a team lead's team or an HR
   approver's in-scope department requests, optionally filtered by status.
3. **Get one request status + timeline** — a single request's current status and
   its append-only transition history, projected to a role-appropriate,
   PII-safe timeline.

## Read Model & Projections

The read model is derived, never authored:

```
                       unit-request-workflow (command side, owner of truth)
                                  │  append-only VacationRequest history
                                  ▼
          VacationRequestRepository  (findById | findByOwner | findByDepartmentAndStatus)
                                  │
   AuthzService.decide(principal, view-permission, { department? })  ◄── unit-platform-authz
                                  │  AuthzGrant { role, departmentScope }
                                  ▼
              StatusQueryService  ──►  scope filter  ──►  projection
                                  │                         │
                RequestStatusView (one)   RequestSummaryView[] (list)   RequestTimelineView (history)
```

- **`RequestStatusView`** — the current status of one request: `id`, `status`,
  `department` (opaque code), `dates`, `version`, `rejectedStage?`. No free-text
  reason at the summary level.
- **`RequestSummaryView`** — the per-row shape of a list: `id`, `status`,
  `dates`, `submittedAtMs` (the `atMs` of the first `Transition`), and the
  `lastUpdatedAtMs` (the `atMs` of the latest `Transition`). Compact and
  PII-lean — designed for the `<MyRequestsList>` / queue tables.
- **`RequestTimelineView`** — the expandable detail: the ordered list of
  `TimelineEntry` projected from the append-only `Transition[]`. Each entry
  carries `from`, `to`, `stage?` (the `WorkflowStage` for a rejection), `atMs`,
  and a **role-gated** `reason?` (see `business-rules` BR-SQ-6). The timeline is
  the "status across roles" surface `req-status-tracking` asks for: an employee
  sees the trajectory of their own request; a lead/HR sees the same trajectory
  for in-scope requests.

Current status is **always** the `to` of the latest `Transition` (never a stored
column this unit maintains) — the same invariant `unit-request-workflow`'s
`BR-INV-4` established. State and history can therefore never disagree, because
they are the same data read two ways.

## Query Flows

### Query A — List my requests (`listOwnRequests`)

Audience: employee. Permission: `request:view-own`. Input: requesting
`AuthenticatedPrincipal`, optional `status` filter. Output:
`Result<RequestSummaryView[], StatusQueryError>`.

```
listOwnRequests(principal, filter?):
  1. authorize: authz.decide(principal, 'request:view-own', {})   [self-scoped]
        deny → err(StatusQueryError.forbidden(decision.reason))   [fail closed]
  2. load candidates: repo.findByOwner(principal.principalId)
  3. scope filter: keep rows where ownerId == principal.principalId  [defence in depth]
  4. optional status filter: keep rows where status == filter.status (if provided)
  5. project each aggregate → RequestSummaryView (PII-lean)
  6. sort by lastUpdatedAtMs desc (most-recently-changed first)
  7. return ok(views)
```

An employee querying their own list can never see another employee's request:
step 1 grants only `view-own`, and step 3 re-asserts owner identity as
defence-in-depth even though `findByOwner` already scopes by owner.

### Query B — List a scoped queue (`listScopedRequests`)

Audience: team lead (own team) or HR (in-scope department). Permission:
`request:view-team` (lead) or `request:view-department` (HR). Input: acting
`AuthenticatedPrincipal`, target `department`, optional `status` filter. Output:
`Result<RequestSummaryView[], StatusQueryError>`.

```
listScopedRequests(principal, department, filter?):
  1. choose permission by intent:
        team-lead queue → 'request:view-team'
        HR department view → 'request:view-department'
  2. authorize: authz.decide(principal, permission, { department })
        deny → err(StatusQueryError.forbidden(reason))
          [HR per-department ABAC + lead own-team scope enforced ENTIRELY by the PDP]
  3. load candidates:
        if a status filter is given → repo.findByDepartmentAndStatus(department, status)
        else → union over the visible statuses for the queue
                (lead queue defaults to Submitted; HR queue defaults to Validated)
  4. scope filter: keep rows whose department is within grant.departmentScope
        (HR); the lead's own-team predicate is already applied by the PDP grant.
  5. project each aggregate → RequestSummaryView
  6. sort by submittedAtMs asc for a work queue (oldest first), else lastUpdatedAtMs desc
  7. return ok(views)
```

This unit does **not** re-implement the "is this my team?" or "is this my
department?" predicate — those live in `unit-platform-authz` (`BR-AUTHZ-5/6`) and
are applied by `decide`. Step 4 is a narrow defence-in-depth filter using the
`departmentScope` the grant already returned, not a second authorization
decision.

### Query C — Get one request status + timeline (`getRequestTimeline`)

Audience: any of the three roles, for a request they are authorized to see.
Permission: resolved from the caller's relationship to the request (see below).
Input: acting `AuthenticatedPrincipal`, `requestId`. Output:
`Result<RequestTimelineView, StatusQueryError>`.

```
getRequestTimeline(principal, requestId):
  1. load request by id
        not found → err(StatusQueryError.notFound())
  2. choose the least-privilege permission that could authorize this read:
        - if request.ownerId == principal.principalId → 'request:view-own'
        - else → 'request:view-team' or 'request:view-department'
                 (the caller's role decides; the PDP is the arbiter)
  3. authorize: authz.decide(principal, permission,
        { department: request.department })
        deny → err(StatusQueryError.forbidden(reason))
  4. project aggregate.history → RequestTimelineView:
        - each Transition → TimelineEntry { from, to, stage?, atMs, reason? }
        - reason is included only when the caller may see it (BR-SQ-6);
          otherwise it is omitted (never redacted-in-place with a placeholder
          that leaks its existence beyond the fact of a transition)
  5. return ok(view)
```

**Order matters and is fail-closed.** Not-found is returned *before* any authz
leak only when the caller has no plausible permission at all; when an
unauthorized caller asks for a real id, the combined `notFound`/`forbidden`
posture never confirms existence to someone out of scope — identical to the
`unit-request-workflow` "Command on unknown request id" edge case, kept
consistent here so the read and command sides leak nothing differently.

## Data Flow & Integration Points

- **Inbound (from HTTP / `unit-platform-auth` + `unit-platform-authz`)**: the
  Express router composes `requireSession(...)` (auth) →
  `requirePermission(authz, '<view-permission>')` (authz) → status-query handler,
  the same pipeline the `unit-request-workflow` router uses. The handler passes
  the `AuthenticatedPrincipal` and validated query params into
  `StatusQueryService`.
- **To `unit-request-workflow` (read model source)**: this unit reads through
  the shipped `VacationRequestRepository` port (`findById`, `findByOwner`,
  `findByDepartmentAndStatus`) — it never writes and never invokes a transition.
  It consumes the `VacationRequest` aggregate's read accessors and `history`
  read-only; it does not reach past the port into workflow internals.
- **To `unit-platform-authz`**: every query calls `AuthzService.decide` with the
  request's/queue's `{ department }` as the `AuthzResource` so the HR
  per-department and lead own-team scoping predicates apply. This unit consumes
  the shipped authz surface verbatim; it does not re-implement RBAC.
- **Outbound**: none on the domain bus. Reads are pure and emit no domain events
  (contrast the command path in [[services]]); the `audit-trail` unit records
  *transitions*, not *views*, so a status read is not itself an audited fact.
- **PII posture**: projections are PII-lean by construction (opaque ids and
  department codes only); free-text `reason` is role-gated at projection time
  (BR-SQ-6) and redacted at every log boundary (`req-nfr-security-pii`).

Persistence access is entirely behind the `VacationRequestRepository` port (one
repository per aggregate root, DDD repository pattern), so the in-memory dev/test
adapter can be swapped for a durable append-only store — or a dedicated read
projection — in production without changing this unit's service or its public
query surface, mirroring the port/adapter seams already shipped across the
monolith (`SessionStore`, `RoleDirectoryPort`, `BalanceCache`).
