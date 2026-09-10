/**
 * RBAC roles & permissions for unit-platform-authz.
 *
 * Grounded in `security-design-unit-platform-authz` (three roles + per-department
 * HR ABAC overlay) and `req-rbac-three-roles-hr-scoping`. Roles are a closed set;
 * there is no "admin" or wildcard role — deny-by-default is the invariant.
 */

/** The three closed RBAC roles (`req-rbac-three-roles-hr-scoping`). */
export const ROLES = ['employee', 'team-lead', 'hr'] as const;

export type Role = (typeof ROLES)[number];

/** Type guard for the closed role set. Unknown values fail closed downstream. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Permissions are coarse-grained capabilities on the vacation-request workflow.
 * The PDP maps roles → permissions via a precompiled table (`role-policy.ts`).
 * Permission names are stable, resource-agnostic verbs; per-resource scoping
 * (e.g. HR department) is layered on top as an ABAC overlay in the service.
 */
export const PERMISSIONS = [
  'request:submit', // employee submits their own vacation request
  'request:view-own', // employee views their own requests
  'request:validate', // team lead validates/rejects a team member's request
  'request:view-team', // team lead views their team's requests
  'request:approve', // HR approves/rejects a lead-validated request
  'request:view-department', // HR views requests within their department scope
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Type guard for the closed permission set. */
export function isPermission(value: unknown): value is Permission {
  return (
    typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
  );
}
