/**
 * Domain read-model & Result types for unit-hris-balance.
 *
 * Grounded in domain-entities (HRIS Balance Read-Model Value Objects & Result
 * Types) and business-logic-model (Read-Through Workflow & Data
 * Transformation). This unit owns NO aggregate: it projects HRIS leave-balance
 * data as immutable, advisory, display-only value objects
 * (req-display-only-balance). The HRIS is the system of record
 * (req-constraint-hris-system-of-record) — there is no write path anywhere in
 * this unit.
 *
 * PII rule (business-rules Invariants, Authorization & PII Rules;
 * req-nfr-security-pii): employee balance data is PII. Error messages and
 * degraded outcomes MUST NOT carry raw employee identifiers, HRIS payloads, or
 * balance figures.
 */

/** Stable reference to the employee whose balance is being displayed. */
export type EmployeeRef = string;

/**
 * Immutable, display-only projection of a leave balance. Units are whole/
 * fractional days (see code-generation memory open question). All figures are
 * advisory: the HRIS remains the system of record.
 */
export interface LeaveBalance {
  /** Employee this balance belongs to (matches the requesting principal). */
  readonly employeeRef: EmployeeRef;
  /** Days accrued for the current entitlement period. */
  readonly accruedDays: number;
  /** Days already taken/booked against the entitlement. */
  readonly usedDays: number;
  /** Days still available to request (accrued - used, as reported by HRIS). */
  readonly remainingDays: number;
  /** Epoch ms the HRIS reported this snapshot as current. */
  readonly asOf: number;
  /** True when served past the freshness window (still displayable, advisory). */
  readonly stale: boolean;
}

/**
 * Why a balance could not be shown as a live value. Kept coarse and PII-free
 * on purpose — the UI shows a generic "temporarily unavailable" state.
 */
export type BalanceUnavailableReason =
  | 'HRIS_TIMEOUT' // fetch exceeded the display-path budget (performance-design)
  | 'HRIS_UNAVAILABLE' // HRIS back-channel failure / transport error
  | 'HRIS_MALFORMED' // HRIS returned a shape we cannot safely project
  | 'NOT_FOUND'; // HRIS has no balance record for the employee

/**
 * Outcome of a balance read. Unavailability is an EXPECTED, advisory display
 * state (non-blocking degradation, business-logic-model "Degradation,
 * Staleness & the No-Write / Advisory Invariants") — NOT a caller error, so it
 * travels inside `Result.ok`. `Result.err` is reserved for hard faults such as
 * invalid input.
 */
export type BalanceOutcome =
  | { readonly status: 'available'; readonly balance: LeaveBalance }
  | { readonly status: 'unavailable'; readonly reason: BalanceUnavailableReason };

export function available(balance: LeaveBalance): BalanceOutcome {
  return { status: 'available', balance };
}

export function unavailable(reason: BalanceUnavailableReason): BalanceOutcome {
  return { status: 'unavailable', reason };
}

/** Hard-fault error codes for the balance boundary (returned via Result.err). */
export type HrisErrorCode =
  | 'INVALID_EMPLOYEE_REF' // caller supplied an empty/missing employee reference
  | 'FORBIDDEN_SCOPE'; // caller asked for a balance that is not their own

/**
 * Domain error for the HRIS balance boundary. Carries a machine-readable code
 * and a PII-free human message; never embeds raw HRIS payloads or balances.
 */
export class HrisError extends Error {
  readonly code: HrisErrorCode;

  constructor(code: HrisErrorCode, message: string) {
    super(message);
    this.name = 'HrisError';
    this.code = code;
    Object.setPrototypeOf(this, HrisError.prototype);
  }

  static of(code: HrisErrorCode, message: string): HrisError {
    return new HrisError(code, message);
  }
}
