/**
 * Authorization decision types & typed deny reasons for unit-platform-authz.
 *
 * Grounded in `security-design-unit-platform-authz` ("Fail-Closed, Ordered
 * Deny-by-Default Checks"). Every deny maps to exactly one machine-readable
 * reason so callers (and the audit trail, out of unit) can act on the code
 * without ever inspecting PII.
 *
 * PII rule (`req-nfr-security-pii`): reasons and messages MUST NOT contain the
 * subject's raw principal id, email, or department. Messages are static,
 * PII-free constants.
 */

/** Ordered fail-closed deny reasons (matches the check order in AuthzService). */
export type AuthzDenyReason =
  | 'UNAUTHENTICATED' // no authenticated principal on the request
  | 'ROLE_UNRESOLVED' // no role in claims and directory could not resolve one
  | 'ROLE_UNKNOWN' // resolved value is not one of the three closed roles
  | 'PERMISSION_DENIED' // role does not grant the requested permission
  | 'DEPARTMENT_OUT_OF_SCOPE' // HR ABAC: resource department outside HR scope
  | 'DIRECTORY_UNAVAILABLE'; // role directory lookup failed -> fail closed

/**
 * Typed authorization error. Carries a machine-readable reason and a PII-free
 * message. Mirrors `SsoError` from unit-platform-auth for a consistent boundary
 * error shape across the monolith.
 */
export class AuthzError extends Error {
  readonly reason: AuthzDenyReason;

  constructor(reason: AuthzDenyReason, message: string) {
    super(message);
    this.name = 'AuthzError';
    this.reason = reason;
    Object.setPrototypeOf(this, AuthzError.prototype);
  }

  static of(reason: AuthzDenyReason, message: string): AuthzError {
    return new AuthzError(reason, message);
  }
}

/**
 * Successful decision payload. Exposes the resolved role and effective
 * department scope so the caller (workflow unit) can apply row-level filters
 * without re-deriving them.
 */
export interface AuthzGrant {
  readonly role: import('./roles.js').Role;
  /**
   * Department scope the decision was granted under. Empty for employee/
   * team-lead (self/team scoped elsewhere); the HR approver's department(s)
   * for the `hr` role.
   */
  readonly departmentScope: readonly string[];
}
