# Vacation Request App — Business Logic Model — `unit-platform-authz`

Functional design for the **Authorization & RBAC** unit. This unit resolves the
authenticated identity established upstream into a role- and department-scoped
authorization decision, and protects the PII carried on that identity.

Scope is bound to the two stories the [[unit-of-work-story-map]] assigns to
`unit-platform-authz`:

- `story-rbac-role-access` — Role-scoped access for employee, team lead, and HR
  (covers `req-rbac-three-roles-hr-scoping`).
- `story-pii-protection` — PII protection and encryption (covers
  `req-nfr-security-pii`).

Per the [[unit-of-work]] `unit-platform-authz — Authorization and RBAC`
definition, this unit depends on `unit-platform-auth` and is consumed by the
`vacation-request-workflow`, `status-tracking`, and downstream components. The
[[components]] architecture places `authorization-rbac` with the dependency
`authorization-rbac → auth-sso-adapter`; the [[services]] artifact groups it in
the platform/identity service namespace on the synchronous **command path**
(orchestration, not choreography). The public method shapes are fixed by
[[component-methods]] (`authorization-rbac` section) and are the contract this
model elaborates.

## Design Approach

Authorization is a **pure, fail-closed policy decision** taken in-process on the
synchronous command path. It mirrors the fail-closed posture already shipped in
the dependency unit `unit-platform-auth`: any inability to resolve a role,
determine a scope, or evaluate a rule yields **deny**, never a permissive
default. There is no in-house identity path — identity arrives already
established as an `AuthenticatedPrincipal` (with `RawClaims { role?, department?,
email? }`) that `unit-platform-auth` forwards **without interpreting**. This
unit is the sole owner of interpreting those raw claims.

The unit exposes two cohesive capability groups, matching [[component-methods]]:

1. **Role/scope resolution** — transform `RawClaims` into a resolved
   `AuthorizationContext` (role + department scope), computed once per request
   and memoized for the request lifetime.
2. **Decision evaluation** — given an `AuthorizationContext` and a requested
   `(action, resource)`, return an `AuthorizationDecision` (`Permit` / `Deny`
   with a machine-readable reason), consulting the static role→permission
   matrix and the dynamic department-scoping predicate.

PII protection (`story-pii-protection`) is a cross-cutting concern realized as a
`CryptoPort` seam plus a redaction rule applied on every log/serialization
boundary. It reuses the "PII forwarded but never logged" invariant already
declared upstream in `RawClaims.email`.

## Core Workflows

### Workflow A — Resolve authorization context (`resolveContext`)

Input: an `AuthenticatedPrincipal` (from `unit-platform-auth`). Output:
`Result<AuthorizationContext, AuthzError>`.

```
resolveContext(principal):
  1. read principal.rawClaims.role         # may be string | string[] | undefined
  2. map claim value(s) → Role via configured RoleClaimMapping
       - no recognizable role claim            → Deny(ROLE_UNRESOLVED)   [fail closed]
       - multiple roles present                → pick highest-privilege per RoleRank,
                                                  record all for audit
  3. read principal.rawClaims.department
       - role == HR and no department claim    → Deny(SCOPE_UNRESOLVED)  [fail closed]
       - role == Employee | TeamLead           → department scopes "own team" only
  4. build DepartmentScope
       - HR      → set of department codes the approver is authorized for
       - TeamLead→ the lead's own department (single)
       - Employee→ self-scope (own requests only)
  5. return ok(AuthorizationContext { principalId, role, scope, resolvedAtMs })
```

The mapping from claim value to `Role` is **configuration**, not hard-coded, so
the exact IdP claim names/shapes (an open question — see `memory.md`) can be set
without code change. Resolution is deterministic and side-effect free.

### Workflow B — Evaluate a decision (`authorize`)

Input: `AuthorizationContext`, `action`, `resourceDescriptor`. Output:
`Result<AuthorizationDecision, AuthzError>`.

```
authorize(ctx, action, resource):
  1. permitted = RolePermissionMatrix[ctx.role].includes(action)
        if not permitted                        → Deny(ACTION_NOT_PERMITTED)
  2. if action is scope-sensitive (see business-rules):
        inScope = DepartmentScope.contains(ctx, resource)
          if not inScope                         → Deny(OUT_OF_SCOPE)
  3. return Permit(reason = ROLE_AND_SCOPE_OK)
```

Both steps are pure predicates over data already in hand — no I/O on the hot
path, consistent with the performance posture of the platform service in
[[services]]. Every `Deny` carries a stable reason code for the immutable audit
trail owned by the `audit-trail` component.

### Workflow C — Protect PII (`encryptPii` / `redactForLog`)

```
encryptPii(plaintextField):
  return CryptoPort.encrypt(plaintextField)      # field-level, at rest

redactForLog(record):
  replace every PII-tagged field (email, names) with a stable non-reversible
  token; NEVER emit raw PII to logs, error messages, or client responses
```

`redactForLog` is invoked at every serialization boundary this unit controls
and is the enforcement point for `req-nfr-security-pii`.

## Data Flow & Integration Points

- **Inbound (from `unit-platform-auth`)**: `AuthenticatedPrincipal` with
  `RawClaims`. This unit is the customer in a customer–supplier relationship;
  the supplier does not interpret roles. This model consumes the shipped
  `AuthenticatedPrincipal`/`RawClaims` shapes verbatim (`src/domain/entities.ts`).
- **Outbound (to `vacation-request-workflow`, `status-tracking`)**: an
  `AuthorizationDecision` and a resolved `AuthorizationContext`; downstream
  components never re-derive roles. This is the orchestration hand-off the
  [[services]] command path describes.
- **To `audit-trail`**: every decision (Permit and Deny) emits an audit fact
  with the reason code and a redacted principal reference — never raw PII.
- **PII at rest**: through `CryptoPort`, satisfying `req-nfr-security-pii` per
  the [[requirements]] non-functional section.

Error handling follows the existing `Result<T, E>` convention
(`src/domain/result.ts`): expected authorization failures are **values**
(`Deny` decisions or `AuthzError`), not thrown exceptions; throwing is reserved
for misconfiguration (e.g. an absent `RolePermissionMatrix`).
