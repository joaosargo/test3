import type { LeaveBalance } from '../domain/balance.js';

/**
 * BalanceCache port — the short-TTL cache-aside store on the display read path
 * (performance-design "Caching Architecture"). A cache MISS or unavailable
 * cache degrades gracefully to a live fetch; it never blocks or errors the
 * caller. Cached entries are the already-projected, PII-bearing read-model, so
 * production implementations must respect the same PII/retention rules
 * (req-nfr-security-pii).
 */
export interface BalanceCache {
  /** Return a cached balance if present and not past its TTL, else null. */
  get(employeeRef: string): Promise<LeaveBalance | null>;

  /** Store a balance under a short TTL. Best-effort; failures are swallowed. */
  set(employeeRef: string, balance: LeaveBalance): Promise<void>;
}
