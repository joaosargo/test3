/**
 * Public API for unit-platform-authz — the in-process RBAC authorization
 * library. The composition root (app.ts / server.ts) and downstream units
 * (vacation-request-workflow, status-tracking) import authorization exclusively
 * through this surface, keeping the PDP's internals encapsulated.
 *
 * Grounded in `unit-of-work` (unit-platform-authz — Authorization and RBAC) and
 * `deployment-architecture-unit-platform-authz` (co-located in-process library).
 */

export { AuthzService } from './services/authz-service.js';
export type {
  AuthzServiceDeps,
  AuthzResource,
} from './services/authz-service.js';

export { requirePermission } from './http/require-permission.js';
export type {
  AuthorizedRequest,
  PrincipalResolver,
  ResourceResolver,
} from './http/require-permission.js';

export { ROLES, PERMISSIONS, isRole, isPermission } from './domain/roles.js';
export type { Role, Permission } from './domain/roles.js';

export { roleGrants, permissionsFor } from './domain/role-policy.js';

export { AuthzError } from './domain/authz-decision.js';
export type { AuthzDenyReason, AuthzGrant } from './domain/authz-decision.js';

export type { RoleAssignment, RoleDirectoryPort } from './ports/role-directory.js';
export { InMemoryRoleDirectory } from './adapters/in-memory-role-directory.js';

export {
  type AuthzPolicy,
  DEFAULT_AUTHZ_POLICY,
} from './config/authz-policy.js';
