/**
 * `WorkflowPendingQueryPort` adapter over the `unit-request-workflow`
 * repository for unit-sla-escalation.
 *
 * Read-only anti-corruption boundary (`business-rules` `BR-SLA-1`): it maps the
 * workflow's existing SCOPED read `findByDepartmentAndStatus` into the narrowed,
 * PII-free `PendingRequestView` the SLA scan consumes — it NEVER touches the
 * mutating `VacationRequest` aggregate API and never persists anything
 * (`business-logic-model` Pending-request read; `logical-components` C5).
 *
 * Because the workflow repository exposes only scoped reads (no unbounded
 * enumeration — the boundary the workflow unit deliberately established), this
 * adapter is given a `departments()` provider and iterates the two awaiting-
 * actor statuses (`Submitted`, `Validated`) per department. Production swaps a
 * read-replica-backed implementation behind the same port with no scan-logic
 * change (`tech-stack-decisions` Integration).
 *
 * PII (`req-nfr-security-pii`, `BR-PII-1`): the produced view carries only
 * pseudonymous ids (`requestId`, `ownerId`, `department`), the non-terminal
 * `status`, and the per-stage clock timestamp — no email, name, or reason.
 */

import type { VacationRequest } from '../../workflow/domain/vacation-request.js';
import type { VacationRequestRepository } from '../../workflow/ports/vacation-request-repository.js';
import type { DepartmentCode, RequestId, RequestStatus } from '../../workflow/domain/value-objects.js';
import type { WorkflowPendingQueryPort } from '../ports/workflow-pending-query-port.js';
import type { PendingRequestView } from '../domain/value-objects.js';

/** The two awaiting-actor statuses in SLA scope (`BR-SLA-1`). */
const PENDING_STATUSES: readonly RequestStatus[] = ['Submitted', 'Validated'];

/**
 * Epoch ms of the latest transition INTO the request's current status — the
 * per-stage SLA clock (`BR-SLA-2`). Reads the append-only history read-only;
 * falls back to the last transition's `atMs` when no matching `to` is found
 * (defensive; the current status always has one such transition).
 */
function enteredCurrentStatusAtMs(request: VacationRequest): number {
  const history = request.history;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].to === request.status) return history[i].atMs;
  }
  return history.length > 0 ? history[history.length - 1].atMs : 0;
}

/** Project a workflow aggregate into the narrowed PII-free view. */
function toView(request: VacationRequest): PendingRequestView {
  return {
    requestId: request.id,
    ownerId: request.ownerId,
    department: request.department,
    status: request.status,
    enteredCurrentStatusAtMs: enteredCurrentStatusAtMs(request),
  };
}

export interface WorkflowPendingQueryAdapterDeps {
  readonly repository: VacationRequestRepository;
  /**
   * The departments to scan (`findByDepartmentAndStatus` is per-department).
   * Injected so the SLA unit does not need an unbounded enumeration API on the
   * workflow repository — preserving the workflow unit's scoped-read boundary.
   */
  readonly departments: () => Promise<readonly DepartmentCode[]> | readonly DepartmentCode[];
}

export class WorkflowPendingQueryAdapter implements WorkflowPendingQueryPort {
  private readonly repository: VacationRequestRepository;
  private readonly departments: WorkflowPendingQueryAdapterDeps['departments'];

  constructor(deps: WorkflowPendingQueryAdapterDeps) {
    this.repository = deps.repository;
    this.departments = deps.departments;
  }

  async listPending(): Promise<readonly PendingRequestView[]> {
    const departments = await this.departments();
    const views: PendingRequestView[] = [];
    for (const department of departments) {
      for (const status of PENDING_STATUSES) {
        const requests = await this.repository.findByDepartmentAndStatus(department, status);
        for (const request of requests) views.push(toView(request));
      }
    }
    return views;
  }

  async findById(requestId: RequestId): Promise<PendingRequestView | null> {
    const request = await this.repository.findById(requestId);
    if (!request) return null;
    // Out of SLA scope once terminal (`BR-SLA-9`).
    if (!PENDING_STATUSES.includes(request.status)) return null;
    return toView(request);
  }
}
