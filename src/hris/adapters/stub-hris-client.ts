import type { EmployeeRef } from '../domain/balance.js';
import type { HrisClientPort, RawHrisBalance } from '../ports/hris-client.js';

/**
 * Stub HrisClientPort for the walking skeleton and unit tests. Seeds a map of
 * employee -> raw balance and supports optional latency / failure injection so
 * the read-through service can be exercised against timeout and back-channel
 * degradation paths (performance-design) without a live HRIS.
 *
 * Read-only, matching the port contract (req-constraint-hris-system-of-record).
 * Production replaces this with a real HRIS SDK adapter behind the same port.
 */
export class StubHrisClient implements HrisClientPort {
  private readonly data: Map<EmployeeRef, RawHrisBalance>;
  private readonly delayMs: number;
  private readonly failWith?: Error;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: {
    seed?: Record<EmployeeRef, RawHrisBalance>;
    delayMs?: number;
    /** When set, every fetch rejects with this error (simulates outage). */
    failWith?: Error;
    /** Injectable sleep so tests can drive delays deterministically. */
    sleep?: (ms: number) => Promise<void>;
  } = {}) {
    this.data = new Map(Object.entries(opts.seed ?? {}));
    this.delayMs = opts.delayMs ?? 0;
    this.failWith = opts.failWith;
    this.sleep =
      opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  }

  async fetchRawBalance(employeeRef: EmployeeRef): Promise<RawHrisBalance | null> {
    if (this.delayMs > 0) await this.sleep(this.delayMs);
    if (this.failWith) throw this.failWith;
    return this.data.get(employeeRef) ?? null;
  }
}
