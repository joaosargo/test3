/**
 * Value objects for unit-request-workflow.
 *
 * Grounded in domain-entities (Value Objects). All value objects are immutable;
 * equality is by attribute value (DDD value-object semantics), consistent with
 * the shipped `LeaveBalance` / `Session` style. Identity and authorization are
 * NOT redefined here — `PrincipalId` is reused read-only from unit-platform-auth
 * (`src/domain/entities.ts`).
 */

import type { PrincipalId } from '../../domain/entities.js';

/** Opaque, unique identifier of a vacation request (UUID string). */
export type RequestId = string;

/** Owning department code — the ABAC key passed to authz as the resource. */
export type DepartmentCode = string;

/**
 * Legal request statuses (domain-entities `RequestStatus`). `Approved`,
 * `Rejected`, `Withdrawn` are terminal (business-rules `BR-WF-6`).
 */
export const REQUEST_STATUSES = ['Submitted', 'Validated', 'Approved', 'Rejected', 'Withdrawn'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Terminal statuses accept no further transition (`BR-WF-6`). */
export const TERMINAL_STATUSES: readonly RequestStatus[] = ['Approved', 'Rejected', 'Withdrawn'];

export function isTerminal(status: RequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Which stage produced a validation/rejection (domain-entities `WorkflowStage`). */
export const WORKFLOW_STAGES = ['TeamLead', 'HR'] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

/**
 * Requested leave period. Inclusive whole-day boundaries (business-rules
 * `BR-VAL-3`, conservative default). Stored as ISO `YYYY-MM-DD` calendar dates.
 */
export interface DateRange {
  readonly startDate: string;
  readonly endDate: string;
}

/** ISO calendar-date pattern (YYYY-MM-DD). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `value` is a well-formed ISO calendar date (`BR-VAL-1`). */
export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/**
 * Do two date ranges overlap? Pure helper consumed by overlap-indicator
 * downstream; defined here as the range primitive it depends on
 * (domain-entities `DateRange.overlaps`). Inclusive boundaries.
 */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

/**
 * Append-only history record (domain-entities `Transition`, `BR-INV-4`).
 * Immutable once appended; the ordered list is the request timeline for
 * status-tracking and the fact stream for audit-trail.
 */
export interface Transition {
  readonly from: RequestStatus | null;
  readonly to: RequestStatus;
  readonly actorId: PrincipalId;
  /** PII-free-in-logs free text (validate/reject/withdraw note). */
  readonly reason?: string;
  readonly atMs: number;
}

/** The validated command payload for `submitRequest` (domain-entities). */
export interface SubmitRequestInput {
  readonly startDate: string;
  readonly endDate: string;
  readonly reason?: string;
}

/** Max length of the optional free-text reason (`BR-VAL-4`). */
export const MAX_REASON_LENGTH = 1000;
