/**
 * AuthzService — the in-process RBAC Policy Decision Point (PDP) for
 * unit-platform-authz.
 *
 * Realizes `story-rbac-role-access` / `req-rbac-three-roles-hr-scoping`. It is
 * the authorization owner DOWNSTREAM of unit-platform-auth: it consumes the
 * already-authenticated `AuthenticatedPrincipal` (read-only) and decides
 * whether that principal may exercise a permission, applying the per-department
 * HR ABAC overlay from `security-design-unit-platform-authz`.
 *
 * Performance (`performance-design-unit-platform-authz`): the decision is
 * in-process and O(1). Role/department are sourced from the principal's SSO
 * claims first; the RoleDirectoryPort is consulted ONLY when claims are absent
 * and `directoryFallback` is enabled — never on the sub-ms hot path for
 * claim-carrying sessions.
 *
 * Fail-closed, ordered, deny-by-default (`security-design-unit-platform-authz`):
 *   1. principal present        -> else UNAUTHENTICATED
 *   2. role resolvable          -> else ROLE_UNRESOLVED / DIRECTORY_UNAVAILABLE
 *   3. role in closed set       -> else ROLE_UNKNOWN
 *   4. role grants permission   -> else PERMISSION_DENIED
 *   5. (HR) department in scope  -> else DEPARTMENT_OUT_OF_SCOPE
 *
 * PII (`req-nfr-security-pii`): principal id and department are PII. This
 * service never logs them; decision outcomes carry only the typed reason.
 */

import type { AuthenticatedPrincipal } from '../../domain/entities.js';
import { type Result, ok, err } from '../../domain/result.js';
import { type AuthzGrant, AuthzError } from '../domain/authz-decision.js';
import { type Permission, type Role, isRole } from '../domain/roles.js';
import { roleGrants } from '../domain/role-policy.js';
import { type AuthzPolicy, DEFAULT_AUTHZ_POLICY } from '../config/authz-policy.js';
import type { RoleAssignment, RoleDirectoryPort } from '../ports/role-directory.js';

export interface AuthzServiceDeps {
  /** Directory fallback for principals whose claims omit role/department. */
  readonly directory: RoleDirectoryPort;
  readonly policy?: AuthzPolicy;
}

/**
 * Optional resource descriptor for the ABAC overlay. When a permission is
 * department-scoped (HR), the caller supplies the resource's department so the
 * PDP can confirm it falls within the principal's HR scope.
 */
export interface AuthzResource {
  readonly department?: string;
}

export class AuthzService {
  private readonly directory: RoleDirectoryPort;
  private readonly policy: AuthzPolicy;

  constructor(deps: AuthzServiceDeps) {
    this.directory = deps.directory;
    this.policy = deps.policy ?? DEFAULT_AUTHZ_POLICY;
  }

  /**
   * Decide whether `principal` may exercise `permission` on an optional
   * `resource`. Returns Ok(grant) on allow, Err(AuthzError) on deny. Never
   * throws for expected denials (Result contract, mirrors AuthService).
   */
  async decide(
    principal: AuthenticatedPrincipal | undefined,
    permission: Permission,
    resource: AuthzResource = {},
  ): Promise<Result<AuthzGrant, AuthzError>> {
    // Check 1 — authenticated principal present.
    if (!principal) {
      return err(AuthzError.of('UNAUTHENTICATED', 'Authentication is required.'));
    }

    // Check 2/3 — resolve role (claims-first, directory fallback), validate set.
    const resolved = await this.resolveAssignment(principal);
    if (!resolved.ok) {
      return err(resolved.error);
    }
    const { role, departments } = resolved.value;

    // Check 4 — role grants the permission (precompiled O(1) table).
    if (!roleGrants(role, permission)) {
      return err(AuthzError.of('PERMISSION_DENIED', 'You do not have permission to perform this action.'));
    }

    // Check 5 — per-department HR ABAC overlay. Only HR carries a department
    // scope; when a resource department is supplied it must fall within it.
    if (role === 'hr' && resource.department !== undefined) {
      if (!departments.includes(resource.department)) {
        return err(
          AuthzError.of('DEPARTMENT_OUT_OF_SCOPE', 'This resource is outside your department scope.'),
        );
      }
    }

    return ok({ role, departmentScope: role === 'hr' ? departments : [] });
  }

  /**
   * Resolve the principal's role + departments. Claims first
   * (`performance-design-unit-platform-authz`); directory fallback only when
   * the role claim is absent and fallback is enabled. Fails closed.
   */
  async resolveAssignment(
    principal: AuthenticatedPrincipal,
  ): Promise<Result<{ role: Role; departments: readonly string[] }, AuthzError>> {
    const claimRole = this.readRoleClaim(principal);
    const claimDept = this.readDepartmentClaim(principal);

    let assignment: { role: string; departments: readonly string[] } | null = null;

    if (claimRole !== undefined) {
      assignment = { role: claimRole, departments: claimDept ? [claimDept] : [] };
    } else if (this.policy.directoryFallback) {
      let looked: RoleAssignment | null;
      try {
        looked = await this.directory.lookup(principal.principalId);
      } catch {
        // Directory read failed — fail closed (never fall back to allow).
        return err(AuthzError.of('DIRECTORY_UNAVAILABLE', 'Authorization is temporarily unavailable.'));
      }
      if (looked === null) {
        return err(AuthzError.of('DIRECTORY_UNAVAILABLE', 'Authorization is temporarily unavailable.'));
      }
      assignment = { role: looked.role, departments: looked.departments };
    }

    if (assignment === null) {
      return err(AuthzError.of('ROLE_UNRESOLVED', 'No role is assigned to this account.'));
    }

    if (!isRole(assignment.role)) {
      return err(AuthzError.of('ROLE_UNKNOWN', 'Assigned role is not recognized.'));
    }

    return ok({ role: assignment.role, departments: assignment.departments });
  }

  /** Read the role claim; normalise string | string[] to a single first value. */
  private readRoleClaim(principal: AuthenticatedPrincipal): string | undefined {
    const raw = (principal.rawClaims as Record<string, unknown>)[this.policy.roleClaim];
    if (typeof raw === 'string' && raw.length > 0) return raw;
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
    return undefined;
  }

  /** Read the department claim (single string) if present. */
  private readDepartmentClaim(principal: AuthenticatedPrincipal): string | undefined {
    const raw = (principal.rawClaims as Record<string, unknown>)[this.policy.departmentClaim];
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  }
}
