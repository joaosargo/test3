# Vacation Request App — Business Rules — `unit-request-workflow`

Decision rules, validation logic, transition guards, and invariants for the
**Vacation Request Workflow** unit. Rules trace to `req-submit-vacation-request`,
`req-team-lead-approve-reject`, `req-hr-approve-reject-no-override`, and
`req-status-tracking` (from [[requirements]]) via the three stories the
[[unit-of-work-story-map]] assigns to this unit (`story-submit-request`,
`story-lead-validate`, `story-hr-approve`). Rule shapes align with the
`vacation-request-workflow` signatures in [[component-methods]] and the
component boundary `vacation-request-workflow → authorization-rbac` in
[[components]]; placement on the synchronous command path is per [[services]] and
the `unit-request-workflow — Vacation Request Workflow Core` definition in
[[unit-of-work]].

Convention: rule ids are stable — `BR-WF-*` for workflow/state rules, `BR-VAL-*`
for input validation, `BR-INV-*` for aggregate invariants. Every guard is
**fail-closed / deny-by-default**: where a guard cannot be satisfied, the command
returns a `Result.err` value and the state is left unchanged. This mirrors the
fail-closed posture already shipped in `unit-platform-auth` and
`unit-platform-authz`.

## Two-Stage Approval Rules

The workflow is strictly two-stage: **team lead validates**, then **HR
approves** — the shape behind `story-lead-validate → story-hr-approve` in
[[requirements]]. This unit owns the *state* half; the `unit-platform-authz`
`business-rules` (`BR-AUTHZ-*`) own the *role/scope* half and are consumed via
`AuthzService.decide`.

| Status | Meaning | Allowed transitions (action → next) |
|--------|---------|-------------------------------------|
| `Submitted` | Employee submitted; awaiting team lead | validate → `Validated`; reject → `Rejected`; withdraw → `Withdrawn` |
| `Validated` | Team lead validated; awaiting HR | approve → `Approved`; reject → `Rejected` |
| `Approved` | HR approved | — (terminal) |
| `Rejected` | Rejected at lead or HR stage | — (terminal) |
| `Withdrawn` | Owner withdrew before lead acted | — (terminal) |

- **BR-WF-1 (Single entry state).** A `submitRequest` always creates the
  aggregate in `Submitted`. There is no other creation path and no server-side
  draft in MVP.
- **BR-WF-2 (Lead gate is mandatory and first).** HR can act only on a
  `Validated` request. There is no transition `Submitted → Approved`; a request
  cannot skip the team-lead stage (`req-team-lead-approve-reject`).
- **BR-WF-3 (Approve/reject only — no override).** At each stage the actor may
  only move the request forward (validate/approve) or terminate it (reject).
  There is no edit-and-approve, no partial approval, and no re-open. Directly
  satisfies `req-hr-approve-reject-no-override` and the lead half of
  `req-team-lead-approve-reject`.
- **BR-WF-4 (Approved requires the HR stage).** `Approved` is reachable only via
  `Validated → Approved` under permission `request:approve`. This is the single
  success terminal.
- **BR-WF-5 (Rejection is terminal and attributed).** A `Rejected` request
  records the `rejectedStage` (`TeamLead` | `HR`) and an optional PII-free
  `reason`. It never returns to an active state.
- **BR-WF-6 (Terminal immutability).** `Approved`, `Rejected`, `Withdrawn` accept
  no further transitions and no field edits. Any command targeting a terminal
  request returns `err(illegalTransition)`.
- **BR-WF-7 (Authorization precedes state guard, both fail closed).** Every
  command first obtains an authorization decision from the PDP, then checks the
  state precondition. A deny short-circuits before any state read/write. Neither
  check has a permissive default (`BR-AUTHZ-8` no-override is thereby respected
  end-to-end).
- **BR-WF-8 (Scope is enforced by authz, applied via resource).** The command
  passes `{ department: request.department, ownerId: request.ownerId }` as the
  `AuthzResource` so the lead own-team (`BR-AUTHZ-6`) and HR per-department
  (`BR-AUTHZ-5`) predicates decide scope. This unit does not re-check department
  membership itself.
- **BR-WF-9 (Owner withdraw before lead action).** An owner may withdraw their
  own `Submitted` request (permission `request:submit` on own resource) — a
  courtesy exit before anyone has acted. Not permitted once `Validated` (open
  question in `memory.md`; conservative default: withdraw only from `Submitted`).

## Input Validation Rules

- **BR-VAL-1 (Dates present & well-formed).** `startDate` and `endDate` are
  required, parse to valid calendar dates. Missing/malformed → `err(invalidInput,
  field)`.
- **BR-VAL-2 (Ordering).** `startDate <= endDate`; an inverted range →
  `err(invalidInput, "endDate")`.
- **BR-VAL-3 (Not in the past).** `startDate` is not before "today" (the request
  cannot book leave in the past). Boundary/inclusivity is an open question
  (`memory.md`); default: dates are inclusive whole days.
- **BR-VAL-4 (Reason length bound).** Optional `reason` is length-capped
  (e.g. ≤ 1000 chars) and treated as free text; it is stored but redacted in
  logs (may contain incidental PII).
- **BR-VAL-5 (Half-day out of MVP).** A half-day / partial-day request is out of
  MVP scope unless product confirms otherwise (`memory.md` open question).
- **BR-VAL-6 (Balance is advisory, never a gate).** Submission is not rejected
  for insufficient displayed balance — the HRIS balance is display-only and
  advisory (`req-display-only-balance`, `req-constraint-hris-system-of-record`).

## Aggregate Invariants

- **BR-INV-1 (Owner is immutable).** `ownerId` is set at submit from the
  authenticated principal and never changes. An actor cannot submit on another
  employee's behalf (self-scope, enforced with authz).
- **BR-INV-2 (Monotonic version).** `version` starts at 1 and increases by
  exactly 1 on each accepted transition. It is the optimistic-concurrency token.
- **BR-INV-3 (Optimistic concurrency).** A transition supplies the
  `expectedVersion`; if it does not match the persisted version the command
  returns `err(staleState)` and applies nothing — the caller re-reads and
  retries. Chosen over locking because contention is low (one lead, then one HR
  approver per request).
- **BR-INV-4 (Append-only history).** Every accepted transition appends a
  `Transition` record (`from`, `to`, `actorId`, `reason?`, `atMs`) and never
  mutates a prior record. Current `status` is the `to` of the latest transition —
  a derived projection, so state and history can never disagree. This feeds the
  immutable `audit-trail` (`req-immutable-audit-trail`) and the role-scoped
  timeline for `status-tracking` (`req-status-tracking`).
- **BR-INV-5 (Event-per-transition).** Exactly one domain event is emitted per
  accepted transition (`RequestSubmitted` / `RequestValidated` /
  `RequestApproved` / `RequestRejected` / `RequestWithdrawn`), in the same
  logical commit as the state change, so no transition is unaudited or
  un-notified.
- **BR-INV-6 (PII-free codes).** All `WorkflowError` codes and reason enums are
  machine-readable and PII-free; free-text reason fields are redacted at every
  log boundary (`req-nfr-security-pii`, mirroring `BR-PII-2`/`BR-PII-5` upstream).

## Validation & Edge Cases

- **Command on unknown request id** → `err(notFound)` (do not leak whether the id
  exists to an unauthorized caller — combined with the prior authz deny this
  stays fail-closed).
- **HR acting on a `Submitted` request** → `err(illegalTransition)` (BR-WF-2): the
  lead stage was skipped.
- **Team lead acting on a `Validated`/terminal request** → `err(illegalTransition)`
  (BR-WF-6).
- **Two approvers act concurrently on the same request** → the second writer
  fails the version check → `err(staleState)` (BR-INV-3); no double transition.
- **Reject with no reason** → permitted; `reason` is optional (BR-WF-5).
- **Authorization deny (wrong role / out of scope)** → `err(forbidden, reason)`
  carrying the authz `AuthzDenyReason` code; no state read/write occurs (BR-WF-7).
- **Withdraw after validation** → `err(illegalTransition)` under the conservative
  default (BR-WF-9).
