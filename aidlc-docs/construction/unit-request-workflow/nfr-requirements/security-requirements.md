# Security Requirements — `unit-request-workflow`

Security NFRs for the **Vacation Request Workflow** unit. The unit is a
command-path domain service; it establishes **no** identity and owns **no**
authorization policy — authentication is delegated to `unit-platform-auth` and
every authorization decision to the `unit-platform-authz` PDP. These
requirements therefore concentrate on how the unit **consumes** those upstream
guarantees fail-closed, and on protecting the data it does own (the
`VacationRequest` aggregate and its history). They trace to the fail-closed
guard ordering in [[business-rules]] (`BR-WF-7`, `BR-WF-8`), the PII invariants
in [[business-logic-model]] and [[business-rules]] (`BR-INV-6`), and
[[requirements]] `req-nfr-security-pii`, `req-rbac-three-roles-hr-scoping`,
`req-immutable-audit-trail`.

## Authentication & Authorization

- **SEC-WF-1 — No in-house auth, no re-derived roles.** The unit never
  authenticates a user or derives roles/department scope itself. Guarded routes
  compose `requireSession(...)` (auth) → `requirePermission(authz,
  '<permission>')` (authz) → handler, exactly as the authz `code-summary`
  integration note prescribes ([[business-logic-model]] Data Flow). Consuming
  the shipped `AuthenticatedPrincipal` and `AuthzService.decide` surface is
  mandatory; re-implementing RBAC is forbidden.
- **SEC-WF-2 — Deny-by-default, authorization before state.** Every command
  obtains an authorization decision from the PDP **before** any state read or
  write; a deny short-circuits with `err(forbidden)` and touches no state
  ([[business-rules]] `BR-WF-7`). There is no permissive branch and no default
  allow on any path.
- **SEC-WF-3 — Scope enforced via the resource descriptor.** Commands pass
  `{ department: request.department, ownerId: request.ownerId }` as the
  `AuthzResource` so the PDP applies team-lead own-team and HR per-department
  ABAC scoping ([[business-rules]] `BR-WF-8`, `req-rbac-three-roles-hr-scoping`).
  The unit does not itself compare departments.
- **SEC-WF-4 — No override, no privilege escalation.** The state guards permit
  only forward (validate/approve) or terminating (reject) transitions and never
  a re-open, edit-and-approve, or stage-skip ([[business-rules]] `BR-WF-2/3/6`).
  This enforces `req-hr-approve-reject-no-override` and the lead half of
  `req-team-lead-approve-reject` end-to-end, complementing the authz unit's
  `BR-AUTHZ-8` no-override.
- **SEC-WF-5 — Self-scoped submission.** `ownerId` is bound to the authenticated
  principal at submit and is immutable ([[business-rules]] `BR-INV-1`); an actor
  cannot submit on another employee's behalf.

## Data Protection & PII

- **SEC-WF-6 — PII-free error codes and events.** All `WorkflowError` codes and
  reason enums are machine-readable and PII-free; domain events carry only
  pseudonymous ids (`requestId`, `ownerId` ref, `department`), never names,
  emails, or free-text beyond the pseudonymous keys ([[business-logic-model]]
  Domain Events, [[business-rules]] `BR-INV-6`, `req-nfr-security-pii`).
- **SEC-WF-7 — Reason text is redacted at log boundaries.** The optional
  free-text `reason` may contain incidental PII; it is stored with the request
  but **never** written to logs or error messages ([[business-rules]] `BR-VAL-4`,
  `BR-INV-6`), mirroring the `BR-PII-*` posture of the upstream units.
- **SEC-WF-8 — Encryption of employee data.** Vacation-request records
  (containing `ownerId`, dates, and reason) are employee PII and must be
  encrypted in transit (TLS on all HTTP) and at rest in the durable append-only
  store (`req-nfr-security-pii`). The in-memory dev/test adapter is
  non-persistent and out of scope for at-rest encryption; the production
  `VacationRequestRepository` adapter must provide it.
- **SEC-WF-9 — No secrets in code.** Any store/credentials the durable adapter
  needs are injected from the environment or a secrets manager, never
  hard-coded — consistent with the shipped `ADR-AUTH-04` convention and the
  team `## Security` rule ("never hardcode credentials").

## Integrity & Auditability

- **SEC-WF-10 — Append-only, tamper-evident history.** History is append-only;
  no prior `Transition` is mutated or deleted, and terminal states are immutable
  ([[business-rules]] `BR-INV-4`, `BR-WF-6`). This is the integrity foundation
  the downstream immutable `audit-trail` (`req-immutable-audit-trail`) builds on;
  this unit is the authoritative event source (`BR-INV-5`).
- **SEC-WF-11 — Exactly-one event per accepted transition.** Every accepted
  transition emits exactly one domain event in the same logical commit as the
  state change ([[business-rules]] `BR-INV-5`), so no state change can be
  silently unaudited.
- **SEC-WF-12 — Optimistic-concurrency prevents lost updates.** The
  version/`expectedVersion` check ([[business-rules]] `BR-INV-3`) prevents two
  concurrent approvers from both writing — the second gets `err(staleState)`,
  eliminating double-transition and lost-update integrity faults.

## Threat Considerations

- **Non-existent-id probing** → commands on an unknown id return `err(notFound)`
  only after the authz deny, so the response does not leak whether an id exists
  to an unauthorized caller ([[business-rules]] Validation & Edge Cases).
- **Cross-department access attempt** → denied by the PDP's HR ABAC / lead
  own-team predicate before any state read (`SEC-WF-2/3`).
- **Replay / forged session** → out of scope for this unit; owned by
  `unit-platform-auth` session validation, which this unit relies on via
  `requireSession`.
- **Tampering with history** → structurally prevented by append-only persistence
  (`SEC-WF-10`); any adapter that permits in-place edit violates the invariant
  and must be rejected in review.
