import { describe, it, expect } from 'vitest';
import { InMemoryBalanceCache } from './in-memory-balance-cache.js';
import type { LeaveBalance } from '../domain/balance.js';

function balance(over: Partial<LeaveBalance> = {}): LeaveBalance {
  return {
    employeeRef: 'emp-1',
    accruedDays: 25,
    usedDays: 10,
    remainingDays: 15,
    asOf: 1000,
    stale: false,
    ...over,
  };
}

describe('InMemoryBalanceCache', () => {
  it('returns null for an unknown key', async () => {
    const cache = new InMemoryBalanceCache();
    expect(await cache.get('missing')).toBeNull();
  });

  it('stores and returns a balance within its TTL', async () => {
    const cache = new InMemoryBalanceCache({ clock: () => 1000, ttlSeconds: 60 });
    await cache.set('emp-1', balance());
    const got = await cache.get('emp-1');
    expect(got?.remainingDays).toBe(15);
  });

  it('expires an entry past its TTL and evicts it', async () => {
    let now = 1000;
    const cache = new InMemoryBalanceCache({ clock: () => now, ttlSeconds: 1 });
    await cache.set('emp-1', balance());
    now = 1000 + 2000; // +2s, past the 1s TTL
    expect(await cache.get('emp-1')).toBeNull();
  });
});
