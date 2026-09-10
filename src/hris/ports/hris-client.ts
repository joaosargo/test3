import type { EmployeeRef } from '../domain/balance.js';

/**
 * Raw leave-balance shape as returned by the corporate HRIS system of record.
 * Deliberately loose/optional — the anti-corruption mapping in
 * BalanceService validates and projects it into the display read-model
 * (business-logic-model "Read-Through Workflow & Data Transformation"). The
 * concrete HRIS product/SDK is an open procurement decision; the port keeps
 * that swap invisible to the service.
 */
export interface RawHrisBalance {
  readonly employeeId?: string;
  readonly accrued?: number;
  readonly used?: number;
  readonly remaining?: number;
  /** HRIS-reported freshness timestamp (epoch ms). */
  readonly asOf?: number;
}

/**
 * HrisClientPort — the read-only anti-corruption boundary around the HRIS
 * system of record (req-constraint-hris-system-of-record). There is NO
 * mutating method by design: this unit never writes to the HRIS on any branch
 * (business-rules "No-Write / Advisory Invariants").
 *
 * Implementations MUST NOT throw for an absent record — they return `null` so
 * the service can map it to a typed NOT_FOUND outcome. Transport/back-channel
 * failures MAY reject; the service catches and degrades non-blockingly.
 */
export interface HrisClientPort {
  /**
   * Fetch the raw balance for an employee, or `null` if the HRIS has no
   * record. Read-only; must never mutate HRIS state.
   */
  fetchRawBalance(employeeRef: EmployeeRef): Promise<RawHrisBalance | null>;
}
