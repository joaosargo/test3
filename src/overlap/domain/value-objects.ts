/**
 * Value objects for unit-overlap-indicator.
 *
 * Grounded in domain-entities (Value Objects owned by this unit). All value
 * objects are immutable; equality is by attribute value (DDD value-object
 * semantics), consistent with the shipped `LeaveBalance` / `Session` style.
 *
 * Design note (domain-entities): this unit adds NO aggregate and NO
 * persistence. Identity, the `VacationRequest` aggregate, its `DateRange` /
 * `RequestStatus` value objects, and the `rangesOverlap` primitive are consumed
 * READ-ONLY from unit-request-workflow (`src/workflow/index.js`) — never
 * redefined here. This module contributes only the two small value objects the
 * indicator owns plus the optional explicit-input query shape.
 */

import type { DateRange, DepartmentCode, RequestId } from '../../workflow/index.js';

/**
 * The advisory result rendered as the team-lead badge (domain-entities
 * `OverlapSummary`). Derived, never persisted (INV-OV-1).
 *
 * Invariants:
 *   - `overlapCount === overlappingIds.length`
 *   - `hasOverlap === overlapCount > 0`   (BR-OV-5)
 *
 * PII (BR-PII-1/2): carries counts and opaque `RequestId`s only — never subject
 * names, emails, or free-text reasons.
 */
export interface OverlapSummary {
  /** `true` iff `overlapCount > 0` (BR-OV-5). */
  readonly hasOverlap: boolean;
  /** Non-negative count of competing overlapping requests (BR-OV-5). */
  readonly overlapCount: number;
  /** Opaque ids of the overlapping requests — pseudonymous, PII-free (BR-PII-1/2). */
  readonly overlappingIds: readonly RequestId[];
  /** The reviewed request's range, echoed for the badge tooltip. */
  readonly window: DateRange;
}

/**
 * Optional explicit-input value object for `computeOverlap` when the caller
 * passes context rather than a bare `requestId` (domain-entities `OverlapQuery`).
 */
export interface OverlapQuery {
  /** Scope key; follows the reviewed request (BR-SCOPE-2). */
  readonly department: DepartmentCode;
  /** The range to test against the department's competing requests. */
  readonly dates: DateRange;
  /** Excluded from the count to prevent self-overlap (BR-OV-4). */
  readonly selfRequestId?: RequestId;
}

/**
 * The competing statuses that reduce team availability and therefore count
 * toward overlap (BR-OV-3). `Rejected` / `Withdrawn` are excluded because they
 * reserve no coverage.
 */
export const COMPETING_STATUSES = ['Submitted', 'Validated', 'Approved'] as const;
