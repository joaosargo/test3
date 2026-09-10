# Code Summary — unit-platform-authz

Implements the Authorization & RBAC unit (`unit-of-work` — unit-platform-authz)
as an **in-process PDP library** co-located in the same deployable as
`unit-platform-auth`, per `deployment-architecture-unit-platform-authz`. Covers
`story-rbac-role-access` (`req-rbac-three-roles-hr-scoping`) and
`story-pii-protection` (`req-nfr-security-pii`).

## Files created

All under `src/authz/` (application code at workspace root, never under
`aidlc-docs/`). No existing files were modified — the unit is purely additive and
consumes `unit-platform-auth`'s `AuthenticatedPrincipal`, `Result`, and
`AuthenticatedRequest` read-only.

| File | Role | Purpose |
|------|------|---------|
| `src/authz/domain/roles.ts` | Domain | Closed set of 3 roles + permissions, type guards |
| `src/authz/domain/authz-decision.ts` | Domain | `AuthzGrant`, `AuthzError`, ordered `AuthzDenyReason` |
| `src/authz/domain/role-policy.ts` | Domain | Precompiled O(1) role→permission grant table |
| `src/authz/ports/role-directory.ts` | Port | `RoleDirectoryPort` anti-corruption boundary |
| `src/authz/config/authz-policy.ts` | Config | Injectable claim-name mapping, directory-fallback flag |
| `src/authz/services/authz-service.ts` | Service | PDP core — fail-closed ordered decision + HR ABAC |
| `src/authz/adapters/in-memory-role-directory.ts` | Adapter | Dev/test double for `RoleDirectoryPort` |
| `src/authz/http/require-permission.ts` | Middleware | Express guard composing on `requireSession` |
| `src/authz/index.ts` | Entrypoint | Public API surface of the authz library |
| `src/authz/services/authz-service.test.ts` | Test | 13 tests — per-role happy paths + deny/fail-closed |
| `src/authz/domain/role-policy.test.ts` | Test | 6 tests — grant table, no cross-role inheritance |
| `src/authz/adapters/in-memory-role-directory.test.ts` | Test | 3 tests — lookup/miss/upsert |
| `src/authz/http/require-permission.test.ts` | Test | 5 tests — allow/401/403/directory/ABAC |

## Key implementation decisions

- **In-process, no hot-path network call** (`performance-design-unit-platform-authz`):
  the grant table is a frozen `Record<Role, Set<Permission>>`; a check is one Set
  membership test. Role/department are read from SSO claims first; the
  `RoleDirectoryPort` is a fallback only when claims are absent.
- **Fail-closed, ordered, deny-by-default** (`security-design-unit-platform-authz`):
  authenticated → role resolvable → role in closed set → permission granted →
  (HR) department in scope. Directory read failure OR unknown principal both deny
  with `DIRECTORY_UNAVAILABLE` (never leaks directory state; never allows).
- **Per-department HR ABAC overlay**: only the `hr` role carries a department
  scope; `request:approve` / `request:view-department` are confined to the HR
  approver's own department(s).
- **PII protection** (`req-nfr-security-pii`): principal id, email, and
  department are never placed in error messages or logs — deny messages are
  static PII-free constants. A dedicated test asserts no PII leaks into messages.
- **Consistency with unit-platform-auth**: reuses the shared `Result<T,E>` type,
  mirrors the `SsoError` shape with `AuthzError`, follows the port/adapter/service
  hexagonal layout and the `.js` ESM import convention. No throwing for expected
  denials — Results only.

## Test coverage summary

- 27 new authz tests; full suite **60 passed** (was 33).
- `typecheck` (tsc --noEmit): clean. `lint` (eslint): clean.
- Coverage over authz modules: services 100%, http 100%, config 100%,
  adapters 100%, domain 97% (line); project overall 98.16% lines / 89.94%
  branches — above the 80/75 thresholds in `vitest.config.ts`.
- Each component covers the happy path + ≥2 error/edge cases (Construction
  phase "Testing Standards" guardrail).

## Deviations from the plan

- **Step 1** split its `authz-error.ts` into `authz-decision.ts` (co-locating the
  `AuthzError` with the `AuthzGrant`/`AuthzDenyReason` it belongs to) rather than
  a separate error file — one cohesive decision module, fewer imports.
- **Step 11**: no new test config — the root `vitest.config.ts` already globs
  `src/**/*.test.ts`, so the new `src/authz/**` tests are picked up automatically.
- Removed an unused `Role` import flagged by `tsc` `noUnusedLocals` in
  `role-directory.ts` (assignment role is `string`, validated by the PDP).

## Integration note for downstream units

`vacation-request-workflow` / `status-tracking` wire authorization by importing
`{ AuthzService, requirePermission, InMemoryRoleDirectory }` from
`src/authz/index.js` and composing `requireSession(...) → requirePermission(authz,
'<permission>')` on guarded routes. Production swaps `InMemoryRoleDirectory` for a
DynamoDB-backed `RoleDirectoryPort` implementation with no PDP change.
