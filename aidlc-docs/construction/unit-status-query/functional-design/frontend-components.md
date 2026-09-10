# Vacation Request App — Frontend Components — `unit-status-query`

> **Conditional artifact.** The stage marks `frontend-components.md` as *only if
> the unit includes frontend/UI*. `unit-status-query` **owns a visible status
> surface**: `req-status-tracking` (via `story-status-tracking` in the
> [[unit-of-work-story-map]]) is a user-facing "track my request across roles"
> capability. This unit therefore defines the **status view** components — the
> read/display half — while `unit-request-workflow` owns the **action** screens
> (submit / decide). This document defines that view hierarchy and its API
> integration.

Grounded in the `status-tracking` signatures of [[component-methods]], the read
endpoints implied by the [[components]] boundary
(`status-tracking → vacation-request-workflow`,
`status-tracking → authorization-rbac`), and the pure query path in [[services]], and
the `unit-status-query — Status Tracking and Query` definition in
[[unit-of-work]]. It consumes the **authorization contract** published by
`unit-platform-authz`
(server-authoritative; the client MUST NOT re-derive authorization) and covers
the status surface for `req-status-tracking` from [[requirements]].

## Boundary with `unit-request-workflow` (no duplication)

`unit-request-workflow` `frontend-components` already sketches `<MyRequestsList>`
and `<RequestStatusBadge>` as the **shells** its action screens embed. This unit
supplies the **data and the read-only detail components** those shells render —
it does not re-implement the action UI. The split:

| Concern | Owner |
|---------|-------|
| Submit form, lead/HR decision bars (mutating) | `unit-request-workflow` |
| Status list rows, status badge, transition **timeline** (read-only) | `unit-status-query` (this unit) |
| The read data (`RequestSummaryView[]`, `RequestTimelineView`) | `unit-status-query` |

Keeping the read components here means the status surface can evolve (add a
timeline, add filters) without touching the command screens — least coupling,
design-for-change.

## Design Principles

- **Server-authoritative visibility.** Which requests a user can see is decided
  by the server PDP (BR-SQ-1..3), never by client filtering. The client renders
  whatever the scoped list endpoint returns and nothing more; it never fetches an
  unscoped list and hides rows locally.
- **Fail-closed rendering.** Unauthenticated → the app redirects to the SSO login
  owned by `unit-platform-auth` (`401`). A `403` on a status read → a generic
  "not permitted" state, never the raw PII-bearing reason (BR-SQ-16).
- **Read-only, no mutation.** These components issue only `GET`s. They surface
  status and history; every state-changing control belongs to
  `unit-request-workflow`'s decision components.
- **Advisory data stays advisory.** Where a status view sits next to a balance or
  overlap hint (approver context), those remain decision aids and never gate or
  alter the displayed status.

## Component Hierarchy

```
<StatusSurface>                       // session-guarded; role from /auth/me (hint only)
 │
 ├─ EMPLOYEE
 │   └─ <MyRequestsView>              // data for unit-request-workflow's <MyRequestsList>
 │        ├─ <StatusFilterBar>        // optional status filter (BR-SQ-12)
 │        ├─ <RequestSummaryRow>*     // one per RequestSummaryView
 │        │    └─ <RequestStatusBadge>
 │        └─ <RequestTimelinePanel>   // expand a row → GET timeline
 │             └─ <TimelineEntryItem>*
 │
 ├─ TEAM-LEAD
 │   └─ <ScopedQueueView role="team-lead">   // own-team queue (view-team)
 │        ├─ <StatusFilterBar defaultStatus="Submitted">
 │        └─ <RequestSummaryRow>* → <RequestTimelinePanel>
 │
 └─ HR
     └─ <ScopedQueueView role="hr">          // department view (view-department)
          ├─ <StatusFilterBar defaultStatus="Validated">
          └─ <RequestSummaryRow>* → <RequestTimelinePanel>
```

`<ScopedQueueView>` is shared between the lead and HR views — the only difference
is the view permission the backing endpoint enforces and the default status
filter, both driven by props, so the queue UI stays cohesive rather than
duplicated.

## Component Contracts (props / state / interaction)

### `<MyRequestsView>` — employee status list (`story-status-tracking`)
- **Props**: `filter?: { status?: RequestStatus }`.
- **State**: `rows: RequestSummaryView[]`, `loading`, `error?`.
- **Interaction**: on mount / filter change → `GET /status/requests?status=…`;
  render one `<RequestSummaryRow>` per row (server already scoped to the owner and
  ordered `lastUpdatedAtMs` desc, BR-SQ-10). On `403` → generic not-permitted; on
  `401` → SSO redirect.

### `<ScopedQueueView>` — lead / HR queue (`req-status-tracking`)
- **Props**: `role: 'team-lead' | 'hr'`, `department: string`,
  `defaultStatus: RequestStatus`.
- **State**: `rows: RequestSummaryView[]`, `loading`, `error?`.
- **Interaction**: `GET /status/departments/:department/requests?status=…`; the
  server enforces `view-team` / `view-department` and per-department ABAC — the
  client sends the department but never trusts its own scoping. Lead queue orders
  oldest-first (BR-SQ-10). Rows outside scope simply never arrive (BR-SQ-7).

### `<RequestStatusBadge>` — current status chip
- **Props**: `status: RequestStatus`, `rejectedStage?: WorkflowStage`.
- Renders the five statuses with distinct, accessible styling (text label + icon,
  not color alone — WCAG). A `Rejected` badge shows the stage
  (`Rejected · Team Lead` / `Rejected · HR`).

### `<RequestTimelinePanel>` / `<TimelineEntryItem>` — the "across roles" timeline
- **Props (panel)**: `requestId: RequestId`; lazy-loads on expand.
- **State**: `view?: RequestTimelineView`, `loading`, `error?`.
- **Interaction**: on expand → `GET /status/requests/:id/timeline`; render each
  `TimelineEntry` chronologically (BR-SQ-11) as a `<TimelineEntryItem>` showing
  `from → to`, `stage?`, a formatted timestamp from `atMs`, and `reason` **only
  when the server included it** (role-gated, BR-SQ-6 — the client renders the
  field iff present, never inferring one). On `404` → "request not found"; on
  `403` → generic not-permitted.

### `<StatusFilterBar>`
- **Props**: `value?: RequestStatus`, `defaultStatus?: RequestStatus`,
  `onChange(status?: RequestStatus)`.
- **State**: selected status. Options are the five closed `RequestStatus` members
  plus "All". An invalid value can never be submitted (closed dropdown), matching
  BR-SQ-12 server-side.

## API Integration Points (read-only)

| Endpoint | Query flow | Permission enforced server-side |
|----------|-----------|---------------------------------|
| `GET /status/requests` | `listOwnRequests` | `request:view-own` |
| `GET /status/departments/:department/requests` | `listScopedRequests` | `request:view-team` or `request:view-department` |
| `GET /status/requests/:id/timeline` | `getRequestTimeline` | resolved per caller relationship (own vs team/dept) |

All three compose `requireSession` → `requirePermission(authz, …)` → handler, the
same pipeline the `unit-request-workflow` router uses. Responses use the shared
PII-free envelope `{ error: { code, message, field? } }` on failure and the
projection value objects (`RequestSummaryView` / `RequestTimelineView`) on
success. HTTP status mapping mirrors the command side:
`INVALID_INPUT → 422`, `FORBIDDEN → 403`, `NOT_FOUND → 404`, unauthenticated
`→ 401`.

## Interaction Flows (end-to-end)

1. **Employee tracks a request (happy path).** Employee opens `<MyRequestsView>` →
   list shows their requests newest-first; badge reads `Submitted`. After the lead
   validates and HR approves, a refresh shows `Approved`; expanding the row loads
   the timeline `Submitted → Validated → Approved` with timestamps and (own
   request) reasons.
2. **Employee sees a rejection with reason.** A lead rejects; the employee's row
   badge reads `Rejected · Team Lead`; the timeline entry shows the lead's reason
   (owner is entitled to it, BR-SQ-6).
3. **Team lead works the queue.** Lead opens `<ScopedQueueView role="team-lead">`
   → `Submitted` requests for their team, oldest first; expands a timeline to see
   history before deciding (the decision itself is `unit-request-workflow`'s UI).
4. **HR department view.** HR opens `<ScopedQueueView role="hr">` → `Validated`
   requests within their department scope; a request from another department never
   appears (server scope, BR-SQ-5/7).
5. **Unauthorized read edge.** A user hits a timeline URL for an out-of-scope
   request → server `403`/`404` (existence not leaked, BR-SQ-4); the UI shows a
   generic not-permitted/not-found state with no PII.
6. **Filter edge.** Selecting a status in `<StatusFilterBar>` re-queries with the
   filter; "All" clears it. An out-of-band bad value is impossible from the closed
   dropdown and would be rejected server-side (BR-SQ-12).

## Form Validation Rules (summary)

This is a read surface — it has no data-entry forms. The only input is the status
filter, constrained to the closed `RequestStatus` set client-side and re-validated
server-side (BR-SQ-12). No client-side authorization filtering is ever relied upon
for security; the server is the source of truth for both **which** requests are
visible and **whether** a reason is shown.
