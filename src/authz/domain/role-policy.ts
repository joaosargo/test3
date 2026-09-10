/**
 * Precompiled role → permission matrix for unit-platform-authz.
 *
 * Grounded in `performance-design-unit-platform-authz` (in-process, precompiled
 * O(1) decision, no hot-path network call) and `req-rbac-three-roles-hr-scoping`.
 *
 * The table is frozen at module load. A permission check is a single Set
 * membership test — no allocation, no I/O, sub-millisecond on the hot path.
 * Deny-by-default is structural: a role that is not a key, or a permission that
 * is not in its set, is denied.
 */

import type { Permission, Role } from './roles.js';

/**
 * Static grant table. Each role's permissions are additive within that role;
 * there is no inheritance between roles (a team lead is NOT implicitly an
 * employee) — grants are explicit to keep the deny-by-default reasoning simple
 * and auditable.
 */
const GRANTS: Readonly<Record<Role, ReadonlySet<Permission>>> = Object.freeze({
  employee: new Set<Permission>(['request:submit', 'request:view-own']),
  'team-lead': new Set<Permission>(['request:validate', 'request:view-team']),
  hr: new Set<Permission>(['request:approve', 'request:view-department']),
});

/**
 * True iff `role` is granted `permission`. Pure, O(1), allocation-free — safe
 * to call on every guarded request (`performance-design-unit-platform-authz`).
 */
export function roleGrants(role: Role, permission: Permission): boolean {
  return GRANTS[role].has(permission);
}

/** All permissions granted to a role (defensive copy). For introspection/tests. */
export function permissionsFor(role: Role): readonly Permission[] {
  return [...GRANTS[role]];
}
