/**
 * `WorkflowPendingQueryPort` — the read-only anti-corruption seam over
 * `unit-request-workflow` for unit-sla-escalation (functional-design
 * `domain-entities` Ports; `business-rules` `BR-SLA-1`).
 *
 * The SLA unit consumes a NARROWED, PII-free `PendingRequestView`, never the
 * mutating `VacationRequest` aggregate API (least coupling, ids only) —
 * preserving the boundary the workflow unit established. The default adapter
 * maps onto the workflow repository's existing `findByDepartmentAndStatus`
 * scoped read. The interface lives in the domain/ports layer; the adapter is
 * the dev/test implementation, swappable for a read-replica-backed
 * implementation in production behind the same seam.
 */

import type { RequestId } from '../../workflow/domain/value-objects.js';
import type { PendingRequestView } from '../domain/value-objects.js';

export interface WorkflowPendingQueryPort {
  /**
   * All requests currently awaiting an actor — status ∈ {`Submitted`,
   * `Validated`} (`BR-SLA-1`). Terminal requests are excluded by construction,
   * so they stop accruing SLA (`BR-SLA-9`).
   */
  listPending(): Promise<readonly PendingRequestView[]>;

  /** Single-request view for an evaluation/debug read; `null` if unknown or terminal. */
  findById(requestId: RequestId): Promise<PendingRequestView | null>;
}
