# Vacation Request App — Domain Entities — `unit-platform-authz`

Entities, value objects, and relationships for the **Authorization & RBAC**
unit. Grounded in the `authorization-rbac` signatures of [[component-methods]],
the component boundary in [[components]] (`authorization-rbac → auth-sso-adapter`),
and the `unit-platform-authz — Authorization and RBAC` definition in
[[unit-of-work]]. The two owned stories in [[unit-of-work-story-map]]
(`story-rbac-role-access`, `story-pii-protection`) and their requirements
(`req-rbac-three-roles-hr-scoping`, `req-nfr-security-pii` from [[requirements]])
drive the attributes below. The unit sits on the synchronous command path per
[[services]].

Design note: identity is **not redefined** here. This unit consumes the
`AuthenticatedPrincipal` and `RawClaims` value objects already shipped by the
dependency unit `unit-platform-auth` and adds only the authorization/PII concepts
it owns. This keeps the customer–supplier boundary clean and avoids duplicate
identity models.

## Value Objects

All value objects are immutable; equality is by attribute value (DDD value-object
semantics).

### `Role` (enum-like value object)
- Members: `Employee`, `TeamLead`, `HR`.
- Carries an intrinsic `rank` (1/2/3) used for highest-privilege selection
  (BR-AUTHZ-3).
- No identity; two `HR` values are interchangeable.

### `DepartmentCode`
- Opaque string identifying an organizational department.
- Prefer over a bare `string` primitive (value-object-over-primitive heuristic).

### `DepartmentScope`
- `kind`: `Self` | `OwnDepartment` | `Departments`.
- `departments`: `ReadonlySet<DepartmentCode>` (populated for HR; a
  single-element set by default — see `memory.md` open question).
- Method (pure): `contains(ctx, resource): boolean` — the scoping predicate
  behind BR-AUTHZ-5/6/7.

### `Action`
- Closed set of permission verbs from the role→permission matrix in
  `business-rules.md`: `request:submit`, `request:view-own`,
  `request:view-team`, `request:view-department`, `request:validate`,
  `request:approve`, `request:reject`, `balance:view-own`.

### `ResourceDescriptor`
- The thing being acted upon, as seen by the authorization decision. Attributes:
  `resourceType` (`VacationRequest` | `Balance`), `ownerId` (`PrincipalId`),
  `department` (`DepartmentCode`).
- Deliberately minimal — carries only what scoping predicates need; the full
  vacation-request aggregate lives in `unit-request-workflow`.

### `AuthorizationDecision`
- `outcome`: `Permit` | `Deny`.
- `reason`: stable code (`ROLE_AND_SCOPE_OK`, `ACTION_NOT_PERMITTED`,
  `OUT_OF_SCOPE`, `ROLE_UNRESOLVED`, `SCOPE_UNRESOLVED`).
- `evaluatedAtMs`: epoch ms. PII-free by construction.

### `AuthzError` (value-level failure)
- `code`: `ROLE_UNRESOLVED` | `SCOPE_UNRESOLVED` | `CONFIG_ERROR` |
  `CRYPTO_UNAVAILABLE`.
- PII-free message. Mirrors the `SsoError` taxonomy convention already shipped
  in the dependency unit; returned inside `Result<T, AuthzError>` per the
  existing `result.ts` convention, not thrown (throwing reserved for
  misconfiguration).

### `RoleClaimMapping` (configuration value object)
- Maps raw IdP claim values → `Role`. Injected, not hard-coded, so IdP claim
  shapes can change without code change.

## Entities & Aggregates

### `AuthorizationContext` (entity — request-scoped)
The resolved authorization identity for one request, produced by `resolveContext`
and consumed by `authorize`.

| Attribute | Type | Notes |
|-----------|------|-------|
| `principalId` | `PrincipalId` | Opaque IdP subject; reused from `unit-platform-auth`. |
| `role` | `Role` | Effective (highest-privilege) role. |
| `allRoles` | `ReadonlySet<Role>` | Recorded for audit (BR-AUTHZ-3). |
| `scope` | `DepartmentScope` | Drives scope-sensitive decisions. |
| `resolvedAtMs` | `number` | For observability; not a security control. |

- Identity: `principalId` + `resolvedAtMs` (request lifetime). No persistence —
  it is a transient projection of the inbound principal, recomputed per request
  (stateless, so it scales horizontally with no session affinity).

### `RolePermissionMatrix` (configuration aggregate root)
- Immutable allow-list: `Role → ReadonlySet<Action>`.
- The single source of truth for role permissions (BR-AUTHZ-4). Loaded once at
  composition time; absence is a misconfiguration (throw, not `Deny`).

### `PiiField` (value object) + `CryptoPort` (port)
- `PiiField`: a tagged wrapper marking a value as PII so redaction/encryption
  applies uniformly.
- `CryptoPort` (anti-corruption port): `encrypt(plaintext): Ciphertext`,
  `decrypt(ciphertext): plaintext`. Realizes BR-PII-3; keeps the crypto provider
  swappable (adapter seam, same hexagonal style as the dependency unit's
  `SessionStore`/`TokenSigner` ports).

## Relationships & Lifecycle

```
AuthenticatedPrincipal (from unit-platform-auth)
        │  rawClaims: RawClaims { role?, department?, email? }
        ▼
   resolveContext ── RoleClaimMapping ──► AuthorizationContext
        │                                   │ role: Role
        │                                   │ scope: DepartmentScope
        ▼                                   ▼
     authorize(ctx, Action, ResourceDescriptor) ──► AuthorizationDecision
        │                                                │
        └───────────────► audit fact (redacted) ─────────┘
                                to audit-trail component

PII path:  RawClaims.email / names ──► PiiField ──► CryptoPort.encrypt (at rest)
                                              └────► redactForLog (at every log/response)
```

Lifecycle states:
- `AuthorizationContext`: `Unresolved → Resolved → (Permit | Deny)` per request,
  then discarded. No stored state, no state machine persistence.
- `AuthorizationDecision`: terminal, immutable once produced; forwarded to the
  command-path caller and to `audit-trail`.

Cross-unit references use **ids, not object graphs**: `ResourceDescriptor` refers
to a vacation request by `ownerId`/`department`, never by embedding the
`unit-request-workflow` aggregate — preserving least coupling across unit
boundaries.
