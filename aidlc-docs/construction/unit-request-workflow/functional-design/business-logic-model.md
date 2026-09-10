# Vacation Request App — Business Logic Model — `unit-request-workflow`

Functional design for the **Vacation Request Workflow** unit — the command-path
core of the application. This unit owns the `VacationRequest` aggregate and
drives it through the strict **two-stage approval workflow**: an employee
submits a request, the team lead **validates or rejects** it, and only a
lead-validated request is forwarded to **HR to approve or reject** — with no
override at either stage.

Scope is bound to the three stories the [[unit-of-work-story-map]] assigns to
`unit-request-workflow`:

- `story-submit-request` — Submit a vacation request (covers
  `req-submit-vacation-request`).
- `story-lead-validate` — Team lead validates or rejects a request (covers
  `req-team-lead-approve-reject`, `req-status-tracking`).
- `story-hr-approve` — HR approves or rejects a validated request (covers
  `req-hr-approve-reject-no-override`).

These requirement ids and the two-stage approve/reject-only shape are defined in
[[requirements]] (functional-requirements section).

Per the [[unit-of-work]] `unit-request-workflow — Vacation Request Workflow
Core` definition, this unit depends on `unit-platform-authz` and is consumed by
`status-tracking`, `overlap-indicator`, `notification`, and `audit-trail`. The
[[components]] architecture places `vacation-request-workflow` with the
dependency `vacation-request-workflow → authorization-rbac`; the [[services]]
artifact puts it on the synchronous **command path** (orchestration) and routes
its **side effects** (audit, notifications, overlap) through choreography. The
public method shapes are fixed by [[component-methods]]
(`vacation-request-workflow` section) and are the contract this model
elaborates.

## Design Approach

The workflow is modelled as an **explicit finite state machine** over the
`VacationRequest` aggregate. Each business action is a **guarded transition**:
the guard combines (a) an **authorization decision** delegated to the
`unit-platform-authz` PDP — the *who-may-act* half — and (b) a **state
precondition** owned here — the *what-may-happen-next* half. This keeps the
least-coupling boundary the authz unit established: this unit never re-derives
roles or department scope; it calls `AuthzService.decide(principal, permission,
resource)` and treats the returned `AuthzGrant` (`role`, `departmentScope`) as
authoritative, consistent with `src/authz/index.ts` and the authz
`business-rules` (`BR-AUTHZ-8` no override, no escalation).

The command path is **orchestrated** in-process: a single service method
validates input, loads the aggregate, evaluates the guard, applies the
transition, persists the new state append-only, and **emits a domain event**.
Side-effecting units (`audit-trail`, `notification`, `overlap-indicator`)
subscribe to those events — this unit does not call them directly, matching the
choreography posture in [[services]]. Emitting the event is part of the same
logical commit as the state change so no transition is silently unaudited
(`req-immutable-audit-trail` is owned by `audit-trail`, but this unit is the
event source).

Error handling follows the shipped `Result<T, E>` convention
(`src/domain/result.ts`): **expected** business failures (validation errors,
illegal transitions, authorization denials, stale-state conflicts) are returned
as `Result.err` values carrying a machine-readable, PII-free code — never thrown.
Throwing is reserved for programmer error / misconfiguration, mirroring the auth
and authz units. PII (employee identifiers, reasons text) is redacted in logs and
error messages per `req-nfr-security-pii`.

The unit exposes three cohesive command capabilities plus supporting reads,
matching [[component-methods]]:

1. **Submit** — create a `VacationRequest` in `Submitted` from validated input.
2. **Validate/Reject (team-lead stage)** — the first approval gate.
3. **Approve/Reject (HR stage)** — the second, terminal approval gate.

## Domain State Machine

```
                         ┌────────────────────────────────────────────┐
                         │                                            │
   submit                │  lead reject            hr reject          │
 (employee)              ▼      │                       │             │
   ● ───────────────►  Submitted ──lead validate──► Validated ──hr approve──► Approved ✔ (terminal)
                          │  │                          │
                          │  └──────► Rejected ◄────────┘   (terminal)
                          │            ▲
             owner withdraw│           │  (rejection is terminal at either stage,
                          ▼            │   carries the rejecting stage + reason)
                       Withdrawn ✔ (terminal, owner-initiated before lead acts)
```

- **Draft** is implicit — a request does not exist until `submit` persists it as
  `Submitted`. (No server-side draft store in MVP.)
- **Submitted → Validated** requires permission `request:validate` (team lead,
  own team) — the team-lead gate.
- **Submitted → Rejected** requires `request:validate` — a lead may reject
  outright without HR ever seeing the request.
- **Validated → Approved** requires `request:approve` (HR, in-scope department) —
  the HR gate. This is the only path to `Approved`.
- **Validated → Rejected** requires `request:approve` — HR may reject a
  lead-validated request.
- **Submitted → Withdrawn** is owner-initiated (`request:submit` on own request)
  before the lead acts (see `business-rules` BR-WF-9; open question in
  `memory.md`).
- `Approved`, `Rejected`, `Withdrawn` are **terminal and immutable**. No
  transition leaves them; no field is edited after entry (feeds the append-only
  audit-trail).

### Workflow A — Submit a request (`submitRequest`)

Input: requesting `AuthenticatedPrincipal`, `SubmitRequestInput { startDate,
endDate, reason? }`. Output: `Result<VacationRequest, WorkflowError>`.

```
submitRequest(principal, input):
  1. authorize: authz.decide(principal, 'request:submit', { }) → self-scoped
        deny → err(WorkflowError.forbidden(decision.reason))          [fail closed]
  2. validate input (see business-rules BR-WF-1..3):
        - startDate/endDate present, well-formed, startDate <= endDate
        - range not in the past (business day rule)
        invalid → err(WorkflowError.invalidInput(field))
  3. build VacationRequest:
        id = new RequestId; ownerId = principal.principalId
        department = grant.department (from resolved context)
        status = Submitted; version = 1
        history = [ Transition{ from: ∅, to: Submitted, actor: owner, atMs } ]
  4. persist via VacationRequestRepository.save (append-only create)
  5. emit RequestSubmitted event (→ audit-trail, notification, overlap-indicator)
  6. return ok(request)
```

Balance sufficiency is **advisory only** — a request is NOT hard-blocked by the
display-only HRIS balance (`req-display-only-balance`,
`req-constraint-hris-system-of-record`); the balance and overlap are decision
aids surfaced to approvers, not submission gates (see `memory.md` open question).

### Workflow B — Team-lead validate or reject (`validateRequest` / `rejectAtLead`)

Input: acting `AuthenticatedPrincipal`, `RequestId`, decision (`validate` |
`reject`), optional `reason`, `expectedVersion`. Output:
`Result<VacationRequest, WorkflowError>`.

```
leadDecision(principal, requestId, decision, reason, expectedVersion):
  1. load request by id
        not found → err(WorkflowError.notFound())
  2. authorize: authz.decide(principal, 'request:validate',
        { department: request.department, ownerId: request.ownerId })
        deny → err(WorkflowError.forbidden(reason))   [own-team scope enforced by authz]
  3. guard state: request.status MUST be Submitted
        else → err(WorkflowError.illegalTransition(from=status, action=decision))
  4. concurrency: request.version MUST equal expectedVersion
        else → err(WorkflowError.staleState())         [optimistic concurrency]
  5. apply transition:
        validate → Validated ;  reject → Rejected(rejectedStage=TeamLead, reason)
        append Transition{ from: Submitted, to, actor: leadId, reason, atMs }
        version += 1
  6. persist (append-only update: new status + appended history)
  7. emit RequestValidated | RequestRejected event
  8. return ok(request)
```

### Workflow C — HR approve or reject (`approveRequest` / `rejectAtHr`)

Input: acting `AuthenticatedPrincipal`, `RequestId`, decision (`approve` |
`reject`), optional `reason`, `expectedVersion`. Output:
`Result<VacationRequest, WorkflowError>`.

```
hrDecision(principal, requestId, decision, reason, expectedVersion):
  1. load request by id ; not found → err(notFound)
  2. authorize: authz.decide(principal, 'request:approve',
        { department: request.department, ownerId: request.ownerId })
        deny → err(forbidden)   [HR per-department ABAC scope enforced by authz]
  3. guard state: request.status MUST be Validated
        else → err(illegalTransition)   [cannot approve a Submitted or terminal request]
  4. concurrency: version == expectedVersion else err(staleState)
  5. apply transition:
        approve → Approved ;  reject → Rejected(rejectedStage=HR, reason)
        append Transition ; version += 1
  6. persist ; emit RequestApproved | RequestRejected
  7. return ok(request)
```

**No override (`req-hr-approve-reject-no-override`,
`req-team-lead-approve-reject`).** There is no transition that lets HR act on a
`Submitted` (not-yet-validated) request, lets a lead act after validation, or
lets any actor reopen a terminal request. The state guards in steps 3 above are
the sole enforcement point, and every guard is deny/illegal-by-default.

## Data Flow & Integration Points

- **Inbound (from HTTP / `unit-platform-auth` + `unit-platform-authz`)**: the
  Express router composes `requireSession(...)` (auth) → `requirePermission(authz,
  '<permission>')` (authz) → workflow handler, exactly as the authz
  `code-summary` integration note prescribes. The handler passes the
  `AuthenticatedPrincipal` and validated body into the service.
- **To `unit-platform-authz`**: every command calls `AuthzService.decide` with
  the request's `{ department, ownerId }` as the `AuthzResource` so the HR
  per-department and lead own-team scoping predicates apply. This unit consumes
  the shipped authz surface verbatim; it does not re-implement RBAC.
- **Outbound domain events (choreography, per [[services]])**:
  `RequestSubmitted`, `RequestValidated`, `RequestApproved`, `RequestRejected`,
  `RequestWithdrawn`. Consumers: `audit-trail` (immutable fact per transition —
  `req-immutable-audit-trail`), `notification` (email + in-app —
  `req-notifications-email-inapp`), `overlap-indicator` (team-lead overlap hint).
- **To `status-tracking` (`req-status-tracking`)**: `status-tracking` queries the
  persisted request state / history projection this unit owns; the current
  `status` is the `to` of the latest transition, and the full history is the
  role-scoped status timeline.
- **Balance (advisory, from `unit-hris-balance`)**: surfaced read-only to the UI
  and approvers; never a write target and never a submission gate.

Persistence is behind a `VacationRequestRepository` port (one repository per
aggregate root, DDD repository pattern) so the in-memory dev/test adapter can be
swapped for a durable append-only store in production without changing the
service — mirroring the port/adapter seams already shipped
(`SessionStore`, `RoleDirectoryPort`, `BalanceCache`).
