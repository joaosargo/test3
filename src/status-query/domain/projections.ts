/**
 * Projection value objects for unit-status-query.
 *
 * Grounded in domain-entities ("Projection Value Objects" / "Query Types"). This
 * unit defines NO entity and NO aggregate — status tracking is a CQRS read model
 * that introduces only immutable, identity-free projection value objects derived
 * per read and never persisted (business-logic-model "Read Model & Projections").
 *
 * All projections are PII-lean by construction (opaque ids + department codes
 * only); free-text `reason` is role-gated at projection time (business-rules
 * BR-SQ-6). The `VacationRequest` value objects (`RequestStatus`, `WorkflowStage`,
 * `DateRange`, `RequestId`) are consumed READ-ONLY from unit-request-workflow and
 * are NOT redefined here — keeping the customer–supplier boundary clean.
 */

import type {
  DateRange,
  RequestId,
  RequestStatus,
  WorkflowStage,
} from '../../workflow/domain/value-objects.js';

/**
 * One row in a status list (`<MyRequestsList>` / lead + HR queues). Compact and
 * reason-free — reason text is never carried at summary level (business-rules
 * BR-SQ-9).
 */
export interface RequestSummaryView {
  readonly id: RequestId;
  readonly status: RequestStatus;
  readonly dates: DateRange;
  /** `atMs` of the first (Submitted) transition. */
  readonly submittedAtMs: number;
  /** `atMs` of the latest transition — drives default list ordering (BR-SQ-10). */
  readonly lastUpdatedAtMs: number;
  /** Present only when `status === 'Rejected'` (mirrors the aggregate). */
  readonly rejectedStage?: WorkflowStage;
}

/**
 * A single projected step of the append-only history (business-rules BR-SQ-11,
 * chronological). `reason` is present ONLY when the caller is entitled to it
 * (BR-SQ-6); the field is omitted otherwise — never a redacted placeholder that
 * would leak that a note existed.
 */
export interface TimelineEntry {
  /** Prior status; `null` for the initial submit. */
  readonly from: RequestStatus | null;
  readonly to: RequestStatus;
  /** Set on a rejection entry to attribute the stage. */
  readonly stage?: WorkflowStage;
  readonly atMs: number;
  /** Role-gated free-text note; omitted when the caller may not see it (BR-SQ-6). */
  readonly reason?: string;
}

/**
 * The single-request detail: current status plus the full ordered timeline. The
 * "status across roles" surface (`req-status-tracking`).
 */
export interface RequestTimelineView {
  readonly id: RequestId;
  readonly status: RequestStatus;
  readonly dates: DateRange;
  /** Opaque department code (no name resolution here). */
  readonly department: string;
  readonly version: number;
  readonly rejectedStage?: WorkflowStage;
  /** Every accepted transition, `atMs` ascending (BR-SQ-11). */
  readonly timeline: readonly TimelineEntry[];
}

/**
 * A minimal current-status projection when the timeline is not needed (e.g. a
 * badge refresh). A strict subset of `RequestTimelineView` without the timeline.
 */
export interface RequestStatusView {
  readonly id: RequestId;
  readonly status: RequestStatus;
  readonly rejectedStage?: WorkflowStage;
  readonly version: number;
}

/**
 * Optional list narrowing for the list reads. An absent `status` means "all
 * visible statuses for this query" (business-rules BR-SQ-12).
 */
export interface StatusQueryFilter {
  readonly status?: RequestStatus;
}
