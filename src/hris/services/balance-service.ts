import {
  type BalanceOutcome,
  type EmployeeRef,
  type LeaveBalance,
  HrisError,
  available,
  unavailable,
} from '../domain/balance.js';
import { type Result, ok, err } from '../../domain/result.js';
import type { HrisClientPort, RawHrisBalance } from '../ports/hris-client.js';
import type { BalanceCache } from '../ports/balance-cache.js';
import {
  type BalancePolicy,
  DEFAULT_BALANCE_POLICY,
} from '../config/balance-policy.js';

export interface BalanceServiceDeps {
  readonly hris: HrisClientPort;
  readonly cache: BalanceCache;
  readonly policy?: BalancePolicy;
  readonly clock?: () => number;
}

/** Marker used to distinguish an internal timeout race from a real value. */
const TIMEOUT = Symbol('hris-fetch-timeout');

/**
 * Display-only HRIS balance read-through service (unit-hris-balance,
 * story-display-balance).
 *
 * Realizes the `getBalance` contract from business-logic-model ("Read-Through
 * Workflow & Data Transformation") satisfying req-display-only-balance and
 * req-constraint-hris-system-of-record. The HRIS is the system of record and
 * this service is strictly read-only — no write path exists on any branch.
 *
 * Degradation is NON-BLOCKING (business-logic-model "Degradation, Staleness &
 * the No-Write / Advisory Invariants" + performance-design 800ms budget): a
 * timeout, transport fault, or malformed payload resolves to a typed
 * `unavailable` OUTCOME inside `Result.ok`, never a thrown error and never an
 * inline retry. `Result.err` is reserved for hard faults (invalid input).
 *
 * PII (business-rules; req-nfr-security-pii): raw HRIS payloads and balance
 * figures never appear in errors or logs.
 */
export class BalanceService {
  private readonly hris: HrisClientPort;
  private readonly cache: BalanceCache;
  private readonly policy: BalancePolicy;
  private readonly now: () => number;

  constructor(deps: BalanceServiceDeps) {
    this.hris = deps.hris;
    this.cache = deps.cache;
    this.policy = deps.policy ?? DEFAULT_BALANCE_POLICY;
    this.now = deps.clock ?? Date.now;
  }

  /**
   * Fetch the display-only leave balance for an employee. Returns a typed
   * outcome; unavailability is expected and non-blocking.
   */
  async getBalance(
    employeeRef: EmployeeRef,
  ): Promise<Result<BalanceOutcome, HrisError>> {
    if (typeof employeeRef !== 'string' || employeeRef.trim() === '') {
      return err(
        HrisError.of('INVALID_EMPLOYEE_REF', 'A valid employee reference is required.'),
      );
    }

    // Cache-aside: a hit short-circuits the HRIS round-trip.
    const cached = await this.safeCacheGet(employeeRef);
    if (cached) {
      return ok(available(this.withFreshness(cached)));
    }

    // Live read under the display-path budget; degrade non-blockingly on any
    // fault instead of retrying inline.
    const raw = await this.fetchWithTimeout(employeeRef);
    if (raw === TIMEOUT) return ok(unavailable('HRIS_TIMEOUT'));
    if (raw instanceof Error) return ok(unavailable('HRIS_UNAVAILABLE'));
    if (raw === null) return ok(unavailable('NOT_FOUND'));

    const projected = this.project(employeeRef, raw);
    if (projected === null) return ok(unavailable('HRIS_MALFORMED'));

    await this.safeCacheSet(employeeRef, projected);
    return ok(available(this.withFreshness(projected)));
  }

  /** Race the HRIS fetch against the configured timeout. Never rejects. */
  private async fetchWithTimeout(
    employeeRef: EmployeeRef,
  ): Promise<RawHrisBalance | null | typeof TIMEOUT | Error> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), this.policy.fetchTimeoutMs);
    });
    try {
      const result = await Promise.race([
        this.hris.fetchRawBalance(employeeRef),
        timeout,
      ]);
      return result;
    } catch (cause) {
      // Back-channel/transport failure -> degrade, no local fallback.
      return cause instanceof Error ? cause : new Error('HRIS fetch failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Anti-corruption mapping from the raw HRIS shape to the display read-model.
   * Returns null when the payload cannot be safely projected (malformed).
   */
  private project(employeeRef: EmployeeRef, raw: RawHrisBalance): LeaveBalance | null {
    const accruedDays = raw.accrued;
    const usedDays = raw.used;
    const remainingDays =
      raw.remaining ??
      (isFiniteNumber(accruedDays) && isFiniteNumber(usedDays)
        ? accruedDays - usedDays
        : undefined);

    if (
      !isFiniteNumber(accruedDays) ||
      !isFiniteNumber(usedDays) ||
      !isFiniteNumber(remainingDays)
    ) {
      return null;
    }

    return {
      employeeRef,
      accruedDays,
      usedDays,
      remainingDays,
      asOf: isFiniteNumber(raw.asOf) ? raw.asOf : this.now(),
      stale: false,
    };
  }

  /** Re-evaluate the staleness flag against the current clock at serve time. */
  private withFreshness(balance: LeaveBalance): LeaveBalance {
    const ageMs = this.now() - balance.asOf;
    const stale = ageMs > this.policy.staleAfterSeconds * 1000;
    return stale === balance.stale ? balance : { ...balance, stale };
  }

  private async safeCacheGet(employeeRef: string): Promise<LeaveBalance | null> {
    try {
      return await this.cache.get(employeeRef);
    } catch {
      // Cache faults must never block the display path.
      return null;
    }
  }

  private async safeCacheSet(employeeRef: string, balance: LeaveBalance): Promise<void> {
    try {
      await this.cache.set(employeeRef, balance);
    } catch {
      // Best-effort write-behind; ignore cache write failures.
    }
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
