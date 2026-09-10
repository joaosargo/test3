# Code Generation Plan — unit-platform-authz

Authorization & RBAC in-process PDP (Policy Decision Point) library for the
vacation-request modular monolith. This unit is co-located in the same
deployable as `unit-platform-auth` (see `deployment-architecture-unit-platform-authz`
— stateless in-process RBAC PDP library on the shared app tier). It consumes the
`AuthenticatedPrincipal` established by `unit-platform-auth` (read-only) and owns
role/department authorization decisions.

## Grounding

- Consumes `requirements` (`req-rbac-three-roles-hr-scoping`, `req-nfr-security-pii`),
  `unit-of-work` (unit-platform-authz — Authorization and RBAC),
  `security-design-unit-platform-authz`, `performance-design-unit-platform-authz`,
  `deployment-architecture-unit-platform-authz`.
- Depends on completed unit `unit-platform-auth` (its `AuthenticatedPrincipal`,
  `Result`, `session-middleware` are read-only inputs).

## Story → code-step traceability

| Story | Requirement | Plan steps |
|-------|-------------|------------|
| `story-rbac-role-access` — Role-scoped access for employee, team lead, HR | `req-rbac-three-roles-hr-scoping` | Steps 2, 3, 4, 5, 6, 7 |
| `story-pii-protection` — PII protection and encryption | `req-nfr-security-pii` | Steps 3, 5, 8 |

## Design decisions (grounded)

- **In-process, no hot-path network call** (`performance-design-unit-platform-authz`):
  the PDP precompiles a role → permission lookup at construction; each guarded
  route resolves an O(1) decision. Role/department are sourced from the
  session principal's claims first; the `RoleDirectoryPort` (DynamoDB read-model
  in prod) is an anti-corruption fallback, never called on the sub-ms hot path
  unless claims are absent.
- **Fail-closed, deny-by-default, ordered checks** (`security-design-unit-platform-authz`):
  authenticated → role resolvable → role grants permission → (HR) department in
  scope. Any failure denies.
- **Three roles**: `employee`, `team-lead`, `hr` (`req-rbac-three-roles-hr-scoping`).
- **Per-department HR ABAC overlay**: HR permissions are scoped to the HR
  approver's own department(s).
- **PII protection** (`req-nfr-security-pii`, `story-pii-protection`): principal
  id and department are PII; never logged verbatim. Decision logs carry a hashed
  principal reference and the decision code only.
- **Hexagonal**: `AuthzService` (PDP) depends on a `RoleDirectoryPort`
  anti-corruption boundary; concrete in-memory adapter for dev/tests, DynamoDB
  swap in prod. Mirrors the existing `unit-platform-auth` port/adapter layout.

## Steps

- [x] **Step 1: Domain model — roles, permissions, decisions**
  `src/authz/domain/roles.ts` (Role, Permission enums/unions),
  `src/authz/domain/authz-decision.ts` (AuthzDecision, AuthzDenyReason, Result reuse),
  `src/authz/domain/authz-error.ts` (typed deny reasons).
  Story: `story-rbac-role-access`.

- [x] **Step 2: Role policy — precompiled role → permission matrix**
  `src/authz/domain/role-policy.ts` — static, precompiled O(1) grant table for
  employee / team-lead / hr; `req-rbac-three-roles-hr-scoping`.
  Story: `story-rbac-role-access`.

- [x] **Step 3: RoleDirectoryPort (anti-corruption boundary)**
  `src/authz/ports/role-directory.ts` — resolve role + department assignments for
  a principal when not present in claims; PII-aware. `req-nfr-security-pii`.
  Story: `story-rbac-role-access`, `story-pii-protection`.

- [x] **Step 4: AuthzService (PDP core)**
  `src/authz/services/authz-service.ts` — resolveRole, decide(permission, resource),
  fail-closed ordered checks, per-department HR ABAC scoping.
  Story: `story-rbac-role-access`.

- [x] **Step 5: AuthzService unit tests**
  `src/authz/services/authz-service.test.ts` — happy paths per role + deny/edge
  cases (unauth, unknown role, missing permission, HR cross-department deny,
  claim/directory fallback, PII-safe deny). `req-rbac-three-roles-hr-scoping`,
  `req-nfr-security-pii`.

- [x] **Step 6: HTTP guard middleware**
  `src/authz/http/require-permission.ts` — Express middleware building on
  `unit-platform-auth`'s `requireSession`; fail-closed 403 on deny.
  Story: `story-rbac-role-access`.

- [x] **Step 7: Middleware + policy unit tests**
  `src/authz/http/require-permission.test.ts`,
  `src/authz/domain/role-policy.test.ts`.

- [x] **Step 8: In-memory RoleDirectory adapter + tests**
  `src/authz/adapters/in-memory-role-directory.ts` (+ `.test.ts`) — dev/test
  double for `RoleDirectoryPort`; DynamoDB swap documented for prod.
  `req-nfr-security-pii`.

- [x] **Step 9: Public unit entrypoint (composition surface)**
  `src/authz/index.ts` — re-export the public API of the authz library
  (AuthzService, ports, roles, guard) for the composition root.

- [x] **Step 10: Configuration**
  `src/authz/config/authz-policy.ts` — default role-claim mapping config
  (claim names, HR department claim), injectable, no hard-coded secrets.

- [x] **Step 11: Test configuration** — reuse existing root `vitest.config.ts`
  (already globs `src/**/*.test.ts`); no change required. Documented here.

- [x] **Step 12: Documentation** — inline TSDoc on every module + README note;
  `code-summary.md` records decisions.

## Test strategy

Testing posture (org rules `## Testing Posture`, `enterprise` scope): tests
alongside code, ≥80% line coverage, run in CI. Standard strategy: unit tests per
component (AuthzService, role-policy, middleware, adapter) covering happy path +
≥2 error/edge cases each, per Construction phase guardrails.
