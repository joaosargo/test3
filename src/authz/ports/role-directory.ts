/**
 * RoleDirectoryPort — anti-corruption boundary over the role/department
 * directory read-model for unit-platform-authz.
 *
 * Grounded in `deployment-architecture-unit-platform-authz` ("Storage Strategy
 * — Role/Department Directory Read Model", a DynamoDB read-model in production)
 * and `performance-design-unit-platform-authz` ("Caching, Claim Sourcing &
 * Store Reads").
 *
 * HOT-PATH RULE: role/department are sourced from the authenticated principal's
 * SSO claims FIRST. This port is the fallback ONLY when the claims are absent —
 * it is never on the sub-millisecond hot path for claim-carrying sessions
 * (`performance-design-unit-platform-authz`). Reads fail closed: a lookup error
 * surfaces as `null` and the PDP denies with `DIRECTORY_UNAVAILABLE`.
 *
 * PII RULE (`req-nfr-security-pii`): the assignment carries the subject's
 * department (PII). Implementations MUST NOT log it; the port contract treats
 * every field as protected.
 */

/** A principal's directory assignment: their role and department membership. */
export interface RoleAssignment {
  /** Resolved role string (validated against the closed set by the PDP). */
  readonly role: string;
  /**
   * Department(s) the principal belongs to. For an HR approver this is the
   * ABAC scope their `request:approve` / `request:view-department` grants apply
   * within (`security-design-unit-platform-authz` per-department overlay).
   */
  readonly departments: readonly string[];
}

export interface RoleDirectoryPort {
  /**
   * Resolve the role/department assignment for a principal id. Returns null if
   * the principal is unknown OR the lookup itself failed — the PDP treats both
   * as fail-closed (it never distinguishes "unknown" from "unavailable" to the
   * caller, to avoid leaking directory state).
   */
  lookup(principalId: string): Promise<RoleAssignment | null>;
}
