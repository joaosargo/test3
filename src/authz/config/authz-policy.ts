/**
 * Authorization policy configuration for unit-platform-authz.
 *
 * Injected, never hard-coded (mirrors `session-policy.ts` in unit-platform-auth
 * and the Construction "Security" guardrail — no secrets in code). Controls how
 * role/department are read from the SSO principal's raw claims
 * (`performance-design-unit-platform-authz` — claim sourcing).
 */

export interface AuthzPolicy {
  /**
   * Name of the raw claim carrying the role, as forwarded by
   * unit-platform-auth in `AuthenticatedPrincipal.rawClaims`. The value may be
   * a string or string[].
   */
  readonly roleClaim: string;
  /** Name of the raw claim carrying the principal's department. */
  readonly departmentClaim: string;
  /**
   * When true, the PDP falls back to the RoleDirectoryPort if the role claim is
   * absent. When false, an absent role claim denies immediately (no store read)
   * — useful for the strict hot-path posture.
   */
  readonly directoryFallback: boolean;
}

/**
 * Defaults align with the raw-claim shape unit-platform-auth forwards
 * (`RawClaims.role`, `RawClaims.department`). Directory fallback is enabled so
 * principals whose IdP omits role claims still resolve via the read-model.
 */
export const DEFAULT_AUTHZ_POLICY: AuthzPolicy = {
  roleClaim: 'role',
  departmentClaim: 'department',
  directoryFallback: true,
};
