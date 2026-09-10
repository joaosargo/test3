# Vacation Request App — Domain Entities — `unit-request-workflow`

Entities, value objects, aggregates, and relationships for the **Vacation
Request Workflow** unit. Grounded in the `vacation-request-workflow` signatures
of [[component-methods]], the component boundary in [[components]]
(`vacation-request-workflow → authorization-rbac`), and the
`unit-request-workflow — Vacation Request Workflow Core` definition in
[[unit-of-work]]. The three owned stories in [[unit-of-work-story-map]]
(`story-submit-request`, `story-lead-validate`, `story-hr-approve`) and their
requirements (`req-submit-vacation-request`, `req-team-lead-approve-reject`,
`req-hr-approve-reject-no-override`, `req-status-tracking` from [[requirements]])
drive the attributes below. The unit sits on the synchronous command path per
[[services]].

Design note: identity and authorization are **not redefined** here. This unit
consumes the shipped `AuthenticatedPrincipal` / `PrincipalId` value objects from
`unit-platform-auth` (`src/domain/entities.ts`) and the `Role` / `Permission` /
`AuthzGrant` types from `unit-platform-authz` (`src/authz/index.ts`) read-only.
It adds only the `VacationRequest` aggregate and its supporting value objects —
which the authz unit deliberately did not model (it carries a minimal
`ResourceDescriptor` by `ownerId`/`department`). This keeps the boundary clean
and avoids duplicating identity or RBAC concepts.

## Value Objects

All value objects are immutable; equality is by attribute value (DDD value-object
semantics), consistent with the shipped `LeaveBalance`/`Session` style.

### `RequestId`
- Opaque, unique identifier of a vacation request (e.g. UUID string).
- Prefer over a bare `string` primitive (value-object-over-primitive heuristic,
  as with `PrincipalId` / `SessionId` upstream).

### `DateRange`
- `startDate`: calendar date; `endDate`: calendar date.
- Invariant `startDate <= endDate` (BR-VAL-2); inclusive whole-day boundaries
  (BR-VAL-3, open question in `memory.md`).
- Pure helper `overlaps(other): boolean` — consumed by `overlap-indicator`
  downstream, defined here as the range primitive it depends on.

### `RequestStatus` (enum-like value object)
- Members: `Submitted`, `Validated`, `Approved`, `Rejected`, `Withdrawn`.
- Carries the legal-transition table (see `business-rules` BR-WF-*). Terminal
  members: `Approved`, `Rejected`, `Withdrawn`.

### `WorkflowStage` (enum-like)
- Members: `TeamLead`, `HR`. Tags which stage produced a validation/rejection —
  stored on `Rejected` as `rejectedStage` (BR-WF-5).

### `Transition` (append-only history record)
- `from`: `RequestStatus | null` (null for the initial submit).
- `to`: `RequestStatus`.
- `actorId`: `PrincipalId` — who performed it (owner, lead, or HR approver).
- `reason?`: PII-free-in-logs free text (validate/reject/withdraw note).
- `atMs`: epoch ms.
- Immutable once appended (BR-INV-4). The ordered list of `Transition`s is the
  request's timeline for `status-tracking` and the fact stream for `audit-trail`.

### `SubmitRequestInput`
- `startDate`, `endDate` (→ `DateRange`), optional `reason`. The validated
  command payload for `submitRequest` (BR-VAL-1..4).

### `WorkflowError` (value-level failure)
- `code`: `INVALID_INPUT` | `NOT_FOUND` | `FORBIDDEN` | `ILLEGAL_TRANSITION` |
  `STALE_STATE`.
- Optional `field` (for `INVALID_INPUT`) and `cause` (for `FORBIDDEN`, echoing
  the authz `AuthzDenyReason`).
- PII-free message. Mirrors the `SsoError` / `AuthzError` / `HrisError` taxonomy
  convention already shipped; returned inside `Result<T, WorkflowError>` per the
  existing `result.ts` convention, **not thrown** (throwing reserved for
  misconfiguration).

## Entities & Aggregates

### `VacationRequest` (aggregate root — the unit's core, and the only one)

The single aggregate root of this unit; all state changes go through it and it
enforces its own invariants (DDD aggregate rules).

| Attribute | Type | Notes |
|-----------|------|-------|
| `id` | `RequestId` | Identity; immutable. |
| `ownerId` | `PrincipalId` | The requesting employee; immutable (BR-INV-1). Reused from `unit-platform-auth`. |
| `department` | `DepartmentCode` (string) | Owning department; the ABAC key passed to authz as the `AuthzResource`. |
| `dates` | `DateRange` | Requested leave period. |
| `reason` | `string?` | Optional employee note. |
| `status` | `RequestStatus` | Current state = `to` of the latest transition (derived, BR-INV-4). |
| `rejectedStage` | `WorkflowStage?` | Set only when `status == Rejected` (BR-WF-5). |
| `history` | `readonly Transition[]` | Append-only ordered transition log (BR-INV-4). |
| `version` | `number` | Monotonic optimistic-concurrency token (BR-INV-2/3). |

Aggregate behaviour (pure, guard-enforcing — no I/O inside the aggregate):
- `submit(...)` — factory producing a `Submitted` request with version 1 and the
  initial transition.
- `validate(actor)`, `rejectAtLead(actor, reason?)` — legal only from
  `Submitted`.
- `approve(actor)`, `rejectAtHr(actor, reason?)` — legal only from `Validated`.
- `withdraw(owner)` — legal only from `Submitted` (BR-WF-9).
- Each returns `Result<VacationRequest, WorkflowError>`; an illegal transition is
  `err(ILLEGAL_TRANSITION)`, never a thrown exception. Authorization is checked
  by the **service** before invoking the aggregate transition (the aggregate is
  pure and does not depend on the PDP).

### `VacationRequestRepository` (port — one per aggregate root)
- `save(request): Promise<Result<void, WorkflowError>>` — create-or-append; the
  append-only store never overwrites history.
- `findById(id): Promise<VacationRequest | null>`.
- Optional scoped reads for the command path (`status-tracking` owns rich
  queries): `findByOwner`, `findByDepartmentAndStatus` — returned aggregates are
  fully constituted (DDD repository rule).
- Interface lives in the domain/ports layer; the in-memory adapter is the
  dev/test implementation, swappable for a durable append-only store in
  production (same hexagonal seam as `SessionStore` / `RoleDirectoryPort` /
  `BalanceCache`).

## Domain Events (emitted to the choreography bus, per [[services]])

Past-tense facts, one per accepted transition (BR-INV-5). Each carries the
`requestId`, `ownerId` (pseudonymous ref), `department`, the new `status`, the
`actorId`, and `atMs` — PII-free beyond the pseudonymous ids.

- `RequestSubmitted` — consumed by `audit-trail`, `notification`,
  `overlap-indicator`.
- `RequestValidated` — consumed by `audit-trail`, `notification`.
- `RequestApproved` — consumed by `audit-trail`, `notification`.
- `RequestRejected` (carries `rejectedStage`) — `audit-trail`, `notification`.
- `RequestWithdrawn` — `audit-trail`, `notification`.

## Relationships & Lifecycle

```
AuthenticatedPrincipal (from unit-platform-auth)
        │  principalId
        ▼
   submitRequest ──► VacationRequest (aggregate root)
        │              id, ownerId, department, dates, status=Submitted, version=1
        │              history=[Transition{ to: Submitted }]
        │
   authz.decide(principal, permission, { department, ownerId })  ◄── unit-platform-authz (read-only)
        │              returns AuthzGrant { role, departmentScope }
        ▼
   lead validate/reject ──► Validated | Rejected(TeamLead)
        │
   hr approve/reject     ──► Approved | Rejected(HR)     (terminal, immutable)
        │
        ├──► append Transition (append-only history, BR-INV-4)
        └──► emit Request* event ──► audit-trail | notification | overlap-indicator
                                     status-tracking reads the persisted state/history
```

Lifecycle states of the aggregate: `Submitted → {Validated → {Approved |
Rejected} | Rejected | Withdrawn}`. Terminal states are immutable (BR-WF-6).

Cross-unit references use **ids, not object graphs** (least coupling): the
`AuthzResource` passed to the PDP is `{ department, ownerId }` only; downstream
consumers receive event payloads keyed by `requestId`, never the aggregate
object itself — preserving the boundaries the authz unit's `domain-entities`
established.
