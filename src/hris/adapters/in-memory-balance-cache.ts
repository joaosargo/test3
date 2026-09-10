import type { LeaveBalance } from '../domain/balance.js';
import type { BalanceCache } from '../ports/balance-cache.js';

interface CacheEntry {
  readonly balance: LeaveBalance;
  readonly expiresAt: number;
}

/**
 * In-memory short-TTL cache-aside implementation for the walking skeleton and
 * tests (performance-design "Caching Architecture"). Production wires a
 * shared/ElastiCache-class store behind the BalanceCache port; the seam keeps
 * that swap invisible to BalanceService.
 *
 * Reads/writes are best-effort by contract: a stale entry simply expires, and
 * the display path degrades non-blockingly on a miss.
 */
export class InMemoryBalanceCache implements BalanceCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: { clock?: () => number; ttlSeconds?: number } = {}) {
    this.now = opts.clock ?? Date.now;
    this.ttlMs = (opts.ttlSeconds ?? 60) * 1000;
  }

  async get(employeeRef: string): Promise<LeaveBalance | null> {
    const entry = this.entries.get(employeeRef);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(employeeRef);
      return null;
    }
    return entry.balance;
  }

  async set(employeeRef: string, balance: LeaveBalance): Promise<void> {
    this.entries.set(employeeRef, {
      balance,
      expiresAt: this.now() + this.ttlMs,
    });
  }
}
