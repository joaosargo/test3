/**
 * `VacationRequest` aggregate root for unit-request-workflow.
 *
 * The single aggregate root of this unit (domain-entities). It is a PURE finite
 * state machine over the two-stage approve/reject-only workflow
 * (business-logic-model Domain State Machine): each transition is a guarded
 * method returning `Result<VacationRequest, WorkflowError>`. There is NO I/O in
 * the aggregate — authorization is checked by the service BEFORE invoking a
 * transition; persistence and event emission happen in the service.
 *
 * Invariants (business-rules):
 *   - BR-INV-1  ownerId immutable, set at submit from the authenticated principal.
 *   - BR-INV-2  version starts at 1, increases by exactly 1 per accepted transition.
 *   - BR-INV-4  history is append-only; status = `to` of the latest transition.
 *   - BR-WF-2   HR can act only on Validated (no Submitted -> Approved).
 *   - BR-WF-6   Approved / Rejected / Withdrawn are terminal & immutable.
 *   - BR-WF-9   withdraw is legal only from Submitted (conservative default).
 *
 * Every transition returns `err(ILLEGAL_TRANSITION)` when the state precondition
 * is not met — never a thrown exception (Result contract, mirrors AuthService).
 */

import { type Result, ok, err } from '../../domain/result.js';
import type { PrincipalId } from '../../domain/entities.js';
import { WorkflowError } from './errors.js';
import {
  type DateRange,
  type DepartmentCode,
  type RequestId,
  type RequestStatus,
  type Transition,
  type WorkflowStage,
  isTerminal,
} from './value-objects.js';

/** Immutable snapshot of the aggregate's persisted state. */
export interface VacationRequestState {
  readonly id: RequestId;
  readonly ownerId: PrincipalId;
  readonly department: DepartmentCode;
  readonly dates: DateRange;
  readonly reason?: string;
  readonly status: RequestStatus;
  readonly rejectedStage?: WorkflowStage;
  readonly history: readonly Transition[];
  readonly version: number;
}

export class VacationRequest {
  private constructor(private readonly state: VacationRequestState) {}

  // --- Factory (business-logic-model Workflow A step 3; BR-WF-1) ---

  /**
   * Create a new request in `Submitted` with version 1 and the initial
   * transition. The only creation path (BR-WF-1). Input is assumed already
   * validated by the service; ownerId comes from the authenticated principal
   * (BR-INV-1) and is never client-supplied.
   */
  static submit(params: {
    id: RequestId;
    ownerId: PrincipalId;
    department: DepartmentCode;
    dates: DateRange;
    reason?: string;
    atMs: number;
  }): VacationRequest {
    const initial: Transition = {
      from: null,
      to: 'Submitted',
      actorId: params.ownerId,
      atMs: params.atMs,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
    };
    return new VacationRequest({
      id: params.id,
      ownerId: params.ownerId,
      department: params.department,
      dates: params.dates,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      status: 'Submitted',
      history: [initial],
      version: 1,
    });
  }

  /** Rehydrate an aggregate from persisted state (repository use). */
  static fromState(state: VacationRequestState): VacationRequest {
    return new VacationRequest(state);
  }

  // --- Read accessors (immutable projections) ---

  get id(): RequestId {
    return this.state.id;
  }
  get ownerId(): PrincipalId {
    return this.state.ownerId;
  }
  get department(): DepartmentCode {
    return this.state.department;
  }
  get status(): RequestStatus {
    return this.state.status;
  }
  get version(): number {
    return this.state.version;
  }
  get rejectedStage(): WorkflowStage | undefined {
    return this.state.rejectedStage;
  }

  /** Defensive copy of the append-only history (BR-INV-4). */
  get history(): readonly Transition[] {
    return [...this.state.history];
  }

  /** Full immutable snapshot for persistence / serialization. */
  toState(): VacationRequestState {
    return { ...this.state, history: [...this.state.history] };
  }

  // --- Team-lead stage (business-logic-model Workflow B) ---

  /** Submitted -> Validated. Legal only from Submitted (BR-WF-2). */
  validate(actor: PrincipalId, atMs: number, reason?: string): Result<VacationRequest, WorkflowError> {
    if (this.state.status !== 'Submitted') return err(WorkflowError.illegalTransition());
    return ok(this.transitionTo('Validated', actor, atMs, reason));
  }

  /** Submitted -> Rejected(TeamLead). A lead may reject outright (BR-WF-5). */
  rejectAtLead(actor: PrincipalId, atMs: number, reason?: string): Result<VacationRequest, WorkflowError> {
    if (this.state.status !== 'Submitted') return err(WorkflowError.illegalTransition());
    return ok(this.transitionTo('Rejected', actor, atMs, reason, 'TeamLead'));
  }

  // --- HR stage (business-logic-model Workflow C) ---

  /** Validated -> Approved. The single success terminal (BR-WF-4). */
  approve(actor: PrincipalId, atMs: number, reason?: string): Result<VacationRequest, WorkflowError> {
    if (this.state.status !== 'Validated') return err(WorkflowError.illegalTransition());
    return ok(this.transitionTo('Approved', actor, atMs, reason));
  }

  /** Validated -> Rejected(HR) (BR-WF-5). */
  rejectAtHr(actor: PrincipalId, atMs: number, reason?: string): Result<VacationRequest, WorkflowError> {
    if (this.state.status !== 'Validated') return err(WorkflowError.illegalTransition());
    return ok(this.transitionTo('Rejected', actor, atMs, reason, 'HR'));
  }

  // --- Owner withdraw (business-rules BR-WF-9) ---

  /** Submitted -> Withdrawn. Owner courtesy exit before the lead acts (BR-WF-9). */
  withdraw(owner: PrincipalId, atMs: number, reason?: string): Result<VacationRequest, WorkflowError> {
    if (this.state.status !== 'Submitted') return err(WorkflowError.illegalTransition());
    return ok(this.transitionTo('Withdrawn', owner, atMs, reason));
  }

  /**
   * Apply an accepted transition: append the history record (BR-INV-4), bump
   * the version by exactly 1 (BR-INV-2), and set the new status. Returns a new
   * immutable aggregate; the receiver is never mutated.
   */
  private transitionTo(
    to: RequestStatus,
    actorId: PrincipalId,
    atMs: number,
    reason: string | undefined,
    rejectedStage?: WorkflowStage,
  ): VacationRequest {
    // Guard against ever transitioning out of a terminal state (BR-WF-6).
    if (isTerminal(this.state.status)) {
      // Unreachable via the public transition methods (each guards its source),
      // retained as a defensive invariant.
      throw new Error('invariant: attempted transition out of a terminal state');
    }
    const record: Transition = {
      from: this.state.status,
      to,
      actorId,
      atMs,
      ...(reason !== undefined ? { reason } : {}),
    };
    return new VacationRequest({
      ...this.state,
      status: to,
      ...(rejectedStage !== undefined ? { rejectedStage } : {}),
      history: [...this.state.history, record],
      version: this.state.version + 1,
    });
  }
}
