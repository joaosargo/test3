/**
 * Balance policy configuration for unit-hris-balance.
 *
 * Values mirror performance-design (Latency Budget & Timeout Design, Caching
 * Architecture): an 800ms display-path fetch budget and short-TTL cache-aside
 * caching. Injected, never hard-coded secrets — this unit reads no secrets
 * (security-design "Authentication & Authorization Model": identity is
 * inherited from unit-platform-auth).
 */
export interface BalancePolicy {
  /** Hard timeout for a single HRIS fetch on the display path (ms). */
  readonly fetchTimeoutMs: number;
  /** Cache-aside TTL for a projected balance (seconds). */
  readonly cacheTtlSeconds: number;
  /**
   * Age (seconds) past which a served balance is marked `stale`. Still
   * displayable (advisory), just flagged as not-fresh.
   */
  readonly staleAfterSeconds: number;
}

export const DEFAULT_BALANCE_POLICY: BalancePolicy = {
  fetchTimeoutMs: 800,
  cacheTtlSeconds: 60,
  staleAfterSeconds: 3600,
};
