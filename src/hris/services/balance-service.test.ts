import { describe, it, expect } from 'vitest';
import { BalanceService } from './balance-service.js';
import { StubHrisClient } from '../adapters/stub-hris-client.js';
import { InMemoryBalanceCache } from '../adapters/in-memory-balance-cache.js';
import type { RawHrisBalance } from '../ports/hris-client.js';

const EMP = 'emp-123';

function raw(over: Partial<RawHrisBalance> = {}): RawHrisBalance {
  return { employeeId: EMP, accrued: 25, used: 10, remaining: 15, asOf: 1000, ...over };
}

function service(opts: {
  hris?: StubHrisClient;
  cache?: InMemoryBalanceCache;
  clock?: () => number;
} = {}): BalanceService {
  const clock = opts.clock ?? ((): number => 1000);
  return new BalanceService({
    hris: opts.hris ?? new StubHrisClient({ seed: { [EMP]: raw() } }),
    cache: opts.cache ?? new InMemoryBalanceCache({ clock }),
    clock,
  });
}

describe('BalanceService.getBalance', () => {
  it('returns an available, fresh balance projected from the HRIS', async () => {
    const svc = service();
    const result = await svc.getBalance(EMP);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.status === 'available') {
      expect(result.value.balance.remainingDays).toBe(15);
      expect(result.value.balance.stale).toBe(false);
    } else {
      throw new Error('expected an available outcome');
    }
  });

  it('rejects an empty employee reference as a hard fault (Result.err)', async () => {
    const svc = service();
    const result = await svc.getBalance('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_EMPLOYEE_REF');
  });

  it('degrades non-blockingly to HRIS_TIMEOUT when the fetch exceeds the budget', async () => {
    // Fetch never resolves within the 5ms budget -> timeout wins the race.
    const hris = new StubHrisClient({ seed: { [EMP]: raw() }, delayMs: 50 });
    const svc = new BalanceService({
      hris,
      cache: new InMemoryBalanceCache(),
      policy: { fetchTimeoutMs: 5, cacheTtlSeconds: 60, staleAfterSeconds: 3600 },
    });
    const result = await svc.getBalance(EMP);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('unavailable');
      if (result.value.status === 'unavailable') {
        expect(result.value.reason).toBe('HRIS_TIMEOUT');
      }
    }
  });

  it('degrades to HRIS_UNAVAILABLE on a back-channel failure (no throw)', async () => {
    const hris = new StubHrisClient({ failWith: new Error('connection reset') });
    const svc = service({ hris });
    const result = await svc.getBalance(EMP);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.status === 'unavailable') {
      expect(result.value.reason).toBe('HRIS_UNAVAILABLE');
    } else {
      throw new Error('expected an unavailable outcome');
    }
  });

  it('degrades to NOT_FOUND when the HRIS has no record for the employee', async () => {
    const svc = service({ hris: new StubHrisClient({ seed: {} }) });
    const result = await svc.getBalance(EMP);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.status === 'unavailable') {
      expect(result.value.reason).toBe('NOT_FOUND');
    }
  });

  it('degrades to HRIS_MALFORMED when the payload cannot be projected', async () => {
    const svc = service({
      hris: new StubHrisClient({ seed: { [EMP]: { employeeId: EMP } } }),
    });
    const result = await svc.getBalance(EMP);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.status === 'unavailable') {
      expect(result.value.reason).toBe('HRIS_MALFORMED');
    }
  });

  it('serves a cache hit without touching the HRIS again', async () => {
    const cache = new InMemoryBalanceCache({ clock: () => 1000 });
    const hris = new StubHrisClient({ seed: { [EMP]: raw() } });
    const svc = new BalanceService({ hris, cache, clock: () => 1000 });
    await svc.getBalance(EMP); // populates cache

    // Swap the HRIS for one that would fail; a cache hit must not call it.
    const failing = new StubHrisClient({ failWith: new Error('should not be called') });
    const svc2 = new BalanceService({ hris: failing, cache, clock: () => 1000 });
    const result = await svc2.getBalance(EMP);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('available');
  });

  it('marks a balance stale when served past the staleness window', async () => {
    let now = 1000;
    const svc = new BalanceService({
      hris: new StubHrisClient({ seed: { [EMP]: raw({ asOf: 1000 }) } }),
      cache: new InMemoryBalanceCache({ clock: () => now, ttlSeconds: 10_000 }),
      policy: { fetchTimeoutMs: 800, cacheTtlSeconds: 10_000, staleAfterSeconds: 60 },
      clock: () => now,
    });
    await svc.getBalance(EMP); // fresh at t=1000
    now = 1000 + 120_000; // +120s, past the 60s staleness window
    const result = await svc.getBalance(EMP);
    if (result.ok && result.value.status === 'available') {
      expect(result.value.balance.stale).toBe(true);
    } else {
      throw new Error('expected an available (stale) outcome');
    }
  });
});
