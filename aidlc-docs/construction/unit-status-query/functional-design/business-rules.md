# Vacation Request App — Business Rules — `unit-status-query`

Decision rules, scope predicates, projection policies, and read invariants for
the **Status Tracking & Query** unit — the read side of the vacation-request
modular monolith. Rules trace to `req-status-tracking` (from [[requirements]])
via the single story the [[unit-of-work-story-map]] assigns to this unit
(`story-status-tracking`). Rule shapes align with the `status-tracking`
signatures in [[component-methods]] and the component boundaries
`status-tracking → vacation-request-workflow` and
`status-tracking → authorization-rbac` in [[components]]; placement on the pure
**query path** (no side effects, no events) is per [[services]] and the
`unit-status-query — Status Tracking and Query` definition in [[unit-of-work]].

Convention: rule ids are stable — `BR-SQ-*` for status-query rules. This unit
owns **no state and no transitions**; therefore it has no workflow or invariant
rules of its own. Its rules govern **authorization of reads**, **scope
filtering**, **projection shape**, and **PII gating**. Every rule is
**fail-closed / deny-by-default**: where a guard cannot be satisfied the query
returns a `Result.err` value and no data is returned, mirroring the posture
shipped in `unit-platform-auth`, `unit-platform-authz`, and
`unit-request-workflow`.

## Read Authorization Rules

The workflow is strictly two-stage and status is visible across all three roles
(`req-status-tracking`). This unit owns the *visibility* half of that
requirement; the `unit-platform-authz` `business-rules` (`BR-AUTHZ-*`) own the
*role/scope* half and are consumed via `AuthzService.decide`.

- **BR-SQ-1 (Every read is authorized first).** No projection is computed and no
  repository row is returned before `AuthzService.decide` returns a permit. A
  deny short-circuits the query with `err(forbidden)` and touches no data. There
  is no permissive default and no "public" read.
- **BR-SQ-2 (View permission is chosen by query intent, least-privilege).** The
  permission passed to the PDP is the narrowest that could authorize the read:
  `request:view-own` for an employee's own-list read; `request:view-team` for a
  team-lead queue; `request:view-department` for an HR department view. These are
  exactly the shipped closed permission set — this unit invents no new
  permissions.
- **BR-SQ-3 (Scope is decided by the PDP, applied here).** This unit does not
  re-derive "is this my team?" (`BR-AUTHZ-6`) or "is this department in my HR
  scope?" (`BR-AUTHZ-5`). It passes `{ department }` as the `AuthzResource`, lets
  `decide` arbitrate, and uses the returned `grant.departmentScope` only for a
  narrow defence-in-depth row filter (BR-SQ-5) — never as a second, independent
  authorization decision.
- **BR-SQ-4 (Unknown id does not leak existence).** A `getRequestTimeline` for an
  id the caller may not see returns `err(notFound)` or `err(forbidden)` in a way
  that never confirms the id exists to an out-of-scope caller — consistent with
  the `unit-request-workflow` "command on unknown request id" edge case, so read
  and command sides leak nothing differently.

## Scope Filtering Rules

- **BR-SQ-5 (Row filter is defence-in-depth, not the security boundary).** After
  a permit, list results are filtered to the allowed set:
  - employee → keep rows where `ownerId == principal.principalId`;
  - team lead → the PDP's own-team predicate already scoped the grant; keep as
    returned;
  - HR → keep rows whose `department` is a member of `grant.departmentScope`.
  This filter is a second layer behind the PDP decision (BR-SQ-1/3); it must
  never *widen* access, only ever *narrow* or confirm it.
- **BR-SQ-6 (Reason text is role-gated at projection time).** A `Transition`'s
  free-text `reason` (a validate/reject/withdraw note that may carry incidental
  PII) is included in a `TimelineEntry` only when the caller is entitled to it:
  the request owner always sees reasons on their own request; a lead/HR sees
  reasons for requests in their scope. When not entitled, the field is **omitted**
  (not returned as a redacted placeholder that would leak that a note existed).
  Machine-readable status/stage codes are always PII-free and always returned.
- **BR-SQ-7 (Out-of-scope rows are omitted, never errored per-row).** A scoped
  list simply does not contain rows outside the caller's scope; the query does
  not return a per-row `forbidden`. Only a whole-query authorization failure
  (BR-SQ-1) produces `err(forbidden)`.

## Projection & Ordering Rules

- **BR-SQ-8 (Status is derived, never stored here).** The current `status` in any
  projection is the `to` of the latest `Transition` in the request's append-only
  history (the `unit-request-workflow` `BR-INV-4` invariant read through the
  port). This unit maintains no status column of its own, so a view can never
  disagree with the command side's truth.
- **BR-SQ-9 (Summary vs timeline shape).** `RequestSummaryView` (list rows) is
  PII-lean: `id`, `status`, `dates`, `submittedAtMs`, `lastUpdatedAtMs`, and
  `rejectedStage?`. `RequestTimelineView` (single request detail) additionally
  carries the ordered `TimelineEntry[]` projected from history, with role-gated
  `reason?` per BR-SQ-6.
- **BR-SQ-10 (Deterministic ordering).** A my-requests list and an HR department
  view sort by `lastUpdatedAtMs` **descending** (most-recently-changed first). A
  team-lead work queue sorts by `submittedAtMs` **ascending** (oldest waiting
  first) so the most-overdue request surfaces at the top. Ordering is stable and
  server-defined; the client does not re-order for correctness.
- **BR-SQ-11 (Timeline is chronological and complete).** `TimelineEntry[]` is
  returned in `atMs` ascending order and includes every accepted transition — the
  read never elides a step, so "status across roles" shows the full trajectory
  (`req-status-tracking`).

## Query Input Validation Rules

- **BR-SQ-12 (Status filter must be a known status).** An optional `status`
  filter must be one of the closed `RequestStatus` members (`Submitted`,
  `Validated`, `Approved`, `Rejected`, `Withdrawn`); an unknown value →
  `err(invalidInput, "status")`. An absent filter means "all visible statuses for
  this query".
- **BR-SQ-13 (Department is required for scoped queues).** `listScopedRequests`
  requires a `department` argument (the ABAC key the PDP scopes on); a missing or
  empty department → `err(invalidInput, "department")`. Own-list reads
  (`listOwnRequests`) take no department (self-scoped).
- **BR-SQ-14 (Request id is required for a timeline read).** `getRequestTimeline`
  requires a non-empty `requestId`; a missing id → `err(invalidInput, "requestId")`.

## Read Invariants

- **BR-SQ-15 (Reads are pure — no writes, no events).** No query mutates the
  aggregate, appends a transition, or emits a domain event. A status read is not
  itself an audited fact; `audit-trail` records transitions, not views. This is
  what keeps the CQRS read side safely separable from the command side.
- **BR-SQ-16 (PII-free codes at every boundary).** All `StatusQueryError` codes
  are machine-readable and PII-free; principal ids, department codes, and
  free-text reasons are redacted at every log boundary
  (`req-nfr-security-pii`, mirroring `BR-PII-*` upstream). Error messages are
  static PII-free constants.
- **BR-SQ-17 (Consistency with the command side).** Because the read model is a
  synchronous on-demand projection over the same append-only store (not a
  separate eventually-consistent copy), a projection reflects every transition
  the command side has committed at read time — there is no read-your-writes gap
  for the vacation domain's scale.

## Validation & Edge Cases

- **Query by an unauthenticated caller** → `err(forbidden)` with reason
  `UNAUTHENTICATED` mapped from the PDP (the guard's check 1); no data read.
- **Employee lists another employee's requests** → impossible: `view-own` grants
  only self scope (BR-SQ-2) and the row filter re-asserts owner identity
  (BR-SQ-5).
- **HR views a department outside scope** → the PDP denies with
  `DEPARTMENT_OUT_OF_SCOPE`; the query returns `err(forbidden)` (BR-SQ-1/3).
- **Team lead opens a timeline for a request whose owner they may see** →
  permitted via `view-team`; reasons are shown (BR-SQ-6).
- **Any role reads a still-active `Submitted`/`Validated` request** → allowed;
  status-tracking is not gated on terminal state — the whole point is visibility
  *during* the workflow (`req-status-tracking`).
- **Unknown status filter value** → `err(invalidInput, "status")` (BR-SQ-12); the
  query does not silently ignore a bad filter.
- **Concurrent transition during a read** → the read reflects whatever is
  committed at read time (BR-SQ-8/17); no lock is taken because reads are pure
  (BR-SQ-15).
