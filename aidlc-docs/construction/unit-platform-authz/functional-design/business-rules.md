# Vacation Request App — Business Rules — `unit-platform-authz`

Decision rules, validation logic, and invariants for the **Authorization &
RBAC** unit. Rules trace to `req-rbac-three-roles-hr-scoping` and
`req-nfr-security-pii` (from [[requirements]]) via the two stories the
[[unit-of-work-story-map]] assigns to this unit (`story-rbac-role-access`,
`story-pii-protection`). Rule shapes align with the `authorization-rbac`
signatures in [[component-methods]] and the component boundary in [[components]];
the unit's placement on the synchronous command path is per [[services]] and the
`unit-of-work` definition `unit-platform-authz — Authorization and RBAC` in
[[unit-of-work]].

Convention: rule ids are stable (`BR-AUTHZ-*` for RBAC, `BR-PII-*` for PII).
Every rule is **fail-closed** — where a rule cannot be evaluated, the outcome is
**Deny**.

## Authorization & Scoping Rules

### Roles (exactly three — MVP)

| Role | Rank | Description |
|------|------|-------------|
| `Employee` | 1 | Submits and views own vacation requests. |
| `TeamLead` | 2 | Validates/rejects requests for their own team; is also an Employee. |
| `HR` | 3 | Approves/rejects team-lead-validated requests within authorized department(s). |

- **BR-AUTHZ-1 (Closed role set).** Only these three roles exist. A claim that
  maps to no known role resolves to `Deny(ROLE_UNRESOLVED)`. No implicit
  "admin"/"superuser" role.
- **BR-AUTHZ-2 (Role resolution is claim-driven).** Role derives solely from the
  IdP `role` claim(s) on `RawClaims`, via a configured `RoleClaimMapping`. This
  unit never assigns roles from any other source.
- **BR-AUTHZ-3 (Highest-privilege wins, all recorded).** If multiple role claims
  are present, the effective role is the highest `Rank`; the full set is recorded
  for the audit fact. `TeamLead` implicitly holds all `Employee` permissions.
- **BR-AUTHZ-4 (Deny by default).** The `RolePermissionMatrix` is an allow-list.
  An action absent from a role's list yields `Deny(ACTION_NOT_PERMITTED)`.

### Role → permission matrix (allow-list)

| Action | Employee | TeamLead | HR |
|--------|:---:|:---:|:---:|
| `request:submit` | ✅ | ✅ | ✅ |
| `request:view-own` | ✅ | ✅ | ✅ |
| `request:view-team` | — | ✅ (own team) | — |
| `request:view-department` | — | — | ✅ (scoped) |
| `request:validate` (team-lead stage) | — | ✅ (own team) | — |
| `request:approve` / `request:reject` (HR stage) | — | — | ✅ (scoped) |
| `balance:view-own` | ✅ | ✅ | ✅ |

The two-stage workflow — team lead **validates**, then HR **approves** — is the
authorization shape behind `story-lead-validate` → `story-hr-approve` in the
[[requirements]]; this unit enforces the *who may act at each stage* half of it.

### Department scoping (`req-rbac-three-roles-hr-scoping`)

- **BR-AUTHZ-5 (HR is per-department scoped).** An `HR` principal may act only on
  requests whose owning department ∈ the principal's `DepartmentScope`. A request
  outside scope yields `Deny(OUT_OF_SCOPE)` even when the action is permitted by
  role. Scope is modelled as a **set** of department codes (an HR approver may
  cover more than one department — see `memory.md` open question); default is a
  single-element set.
- **BR-AUTHZ-6 (Team lead scoped to own team).** A `TeamLead` may validate/view
  only requests within their own department; cross-team access is `OUT_OF_SCOPE`.
- **BR-AUTHZ-7 (Employee self-scope).** An `Employee` may view/submit only their
  own requests (`resource.ownerId == ctx.principalId`), else `OUT_OF_SCOPE`.
- **BR-AUTHZ-8 (No override, no escalation).** There is no rule that lets any
  role bypass scoping or act at another stage. This aligns with
  `req-hr-approve-reject-no-override` and `req-team-lead-approve-reject`
  (approve/reject only, no override) from [[requirements]].
- **BR-AUTHZ-9 (Scope-sensitive actions).** `view-team`, `view-department`,
  `validate`, `approve`, `reject` are scope-sensitive; `submit`, `view-own`,
  `balance:view-own` are self-scoped by construction.

### Evaluation invariants

- **BR-AUTHZ-10 (Purity).** A decision is a pure function of
  `(AuthorizationContext, action, resource)`; no network/DB I/O on the decision
  path (consistent with the [[services]] command-path performance posture).
- **BR-AUTHZ-11 (Every decision is auditable).** Both `Permit` and `Deny` emit an
  audit fact (reason code + redacted principal ref) to the `audit-trail`
  component. Missing audit capability does not block the decision but is a
  logged reliability concern.

## PII Protection Rules

- **BR-PII-1 (PII inventory).** PII fields handled by this unit: subject email
  (`RawClaims.email`), and any human name/identifier that appears alongside a
  decision. `principalId` (opaque IdP subject) is treated as a pseudonymous
  identifier, not free-text PII.
- **BR-PII-2 (Never log raw PII).** Raw PII MUST NOT appear in logs, error
  messages, exception `cause`, or client responses. This extends the invariant
  already declared upstream (`RawClaims.email` — "PII; forwarded but never
  logged"). Enforcement is `redactForLog` at every serialization boundary.
- **BR-PII-3 (Encrypt at rest).** Any PII this unit persists is stored via
  `CryptoPort` field-level encryption; plaintext PII is never written to durable
  storage. Satisfies `req-nfr-security-pii`.
- **BR-PII-4 (Redaction is non-reversible in logs).** Log redaction replaces PII
  with a stable non-reversible token so operational correlation is possible
  without exposing the value.
- **BR-PII-5 (Deny messages are PII-free).** Authorization `Deny` reasons are
  machine codes (e.g. `OUT_OF_SCOPE`) with PII-free human text — mirroring the
  `SsoError` PII rule already shipped in the dependency unit.

## Validation & Edge Cases

- **Absent/empty role claim** → `Deny(ROLE_UNRESOLVED)` (BR-AUTHZ-1). Not an
  exception.
- **HR principal with no department claim** → `Deny(SCOPE_UNRESOLVED)`
  (BR-AUTHZ-5) — HR cannot be unbounded.
- **Malformed/unknown department code on the resource** → `Deny(OUT_OF_SCOPE)`
  (fail closed; do not assume membership).
- **Multi-valued role claim** → highest-privilege wins (BR-AUTHZ-3).
- **`CryptoPort` unavailable at write time** → the persist operation fails
  closed (no plaintext fallback, BR-PII-3); the caller receives an
  `AuthzError(CRYPTO_UNAVAILABLE)`.
- **Concurrent requests for one principal** → context resolution is stateless
  and idempotent; no shared mutable state, so concurrency needs no locking.
