/**
 * `WorkflowService` — the orchestrated command path for unit-request-workflow.
 *
 * Realizes the three owned stories (`story-submit-request`,
 * `story-lead-validate`, `story-hr-approve`) and their requirements
 * (`req-submit-vacation-request`, `req-team-lead-approve-reject`,
 * `req-hr-approve-reject-no-override`, `req-status-tracking`).
 *
 * Each command follows the ordered, fail-closed shape from business-logic-model
 * (Workflows A/B/C) and business-rules (`BR-WF-7` authorization precedes state
 * guard; both deny-by-default):
 *   1. authorize via the authz PDP (AuthzService.decide) — deny -> forbidden
 *   2. validate input / load aggregate
 *   3. state guard via the pure aggregate transition -> illegalTransition
 *   4. optimistic concurrency check (expectedVersion) -> staleState
 *   5. persist (append-only)
 *   6. emit exactly one domain event (BR-INV-5)
 *
 * This unit consumes `AuthzService` READ-ONLY and never re-derives roles or
 * department scope (`BR-WF-8`); the request's `{ department, ownerId }` is
 * passed as the `AuthzResource` so the lead own-team and HR per-department
 * predicates decide scope.
 *
 * Errors are returned as `Result.err(WorkflowError)` values — never thrown for
 * expected failures (mirrors AuthService / AuthzService). PII is redacted at log
 * boundaries and never placed in error codes (`BR-INV-6`, `req-nfr-security-pii`).
 */

import { randomUUID } from 'node:crypto';
import { type Result, ok, err } from '../../domain/result.js';
import type { AuthenticatedPrincipal } from '../../domain/entities.js';
import type { AuthzService } from '../../authz/index.js';
import { WorkflowError } from '../domain/errors.js';
import { VacationRequest } from '../domain/vacation-request.js';
import type { WorkflowEvent } from '../domain/events.js';
import {
  type RequestId,
  type SubmitRequestInput,
  MAX_REASON_LENGTH,
  isValidCalendarDate,
} from '../domain/value-objects.js';
import type { VacationRequestRepository } from '../ports/vacation-request-repository.js';
import type { EventPublisher } from '../ports/event-publisher.js';

/** The team-lead stage decision. */
export type LeadDecision = 'validate' | 'reject';
/** The HR stage decision. */
export type HrDecision = 'approve' | 'reject';

export interface WorkflowServiceDeps {
  readonly repository: VacationRequestRepository;
  readonly authz: AuthzService;
  readonly events: EventPublisher;
  /** Clock seam for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Id generator seam for deterministic tests; defaults to `randomUUID`. */
  readonly newId?: () => RequestId;
}

/** Shared shape for a stage-decision command. */
export interface DecisionCommand {
  readonly requestId: RequestId;
  readonly reason?: string;
  readonly expectedVersion: number;
}

export class WorkflowService {
  private readonly repository: VacationRequestRepository;
  private readonly authz: AuthzService;
  private readonly events: EventPublisher;
  private readonly now: () => number;
  private readonly newId: () => RequestId;

  constructor(deps: WorkflowServiceDeps) {
    this.repository = deps.repository;
    this.authz = deps.authz;
    this.events = deps.events;
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  // --- Workflow A: submit (story-submit-request) ---

  /**
   * Submit a vacation request. Self-scoped authorization (`request:submit`),
   * then input validation (`BR-VAL-1..4`), then create + persist + emit.
   * The department is resolved from the authenticated principal's claims — the
   * owner cannot submit on another employee's behalf (`BR-INV-1`).
   */
  async submitRequest(
    principal: AuthenticatedPrincipal,
    input: SubmitRequestInput,
  ): Promise<Result<VacationRequest, WorkflowError>> {
    // 1. Authorize (fail closed).
    const decision = await this.authz.decide(principal, 'request:submit');
    if (!decision.ok) return err(WorkflowError.forbidden(decision.error.reason));

    // 2. Validate input.
    const validated = this.validateSubmitInput(input);
    if (!validated.ok) return validated;

    // 3-5. Build the aggregate, persist (append-only create), emit.
    const department = decision.value.departmentScope[0] ?? this.readDepartmentClaim(principal) ?? 'UNKNOWN';
    const atMs = this.now();
    const request = VacationRequest.submit({
      id: this.newId(),
      ownerId: principal.principalId,
      department,
      dates: { startDate: validated.value.startDate, endDate: validated.value.endDate },
      ...(validated.value.reason !== undefined ? { reason: validated.value.reason } : {}),
      atMs,
    });

    const saved = await this.repository.save(request);
    if (!saved.ok) return err(saved.error);

    await this.emit({
      type: 'RequestSubmitted',
      requestId: request.id,
      ownerId: request.ownerId,
      department: request.department,
      actorId: principal.principalId,
      status: 'Submitted',
      atMs,
    });
    return ok(request);
  }

  // --- Workflow B: team-lead validate / reject (story-lead-validate) ---

  async leadDecision(
    principal: AuthenticatedPrincipal,
    decision: LeadDecision,
    cmd: DecisionCommand,
  ): Promise<Result<VacationRequest, WorkflowError>> {
    return this.decide(principal, 'request:validate', cmd, (request, actor, atMs) =>
      decision === 'validate'
        ? request.validate(actor, atMs, cmd.reason)
        : request.rejectAtLead(actor, atMs, cmd.reason),
    );
  }

  // --- Workflow C: HR approve / reject (story-hr-approve) ---

  async hrDecision(
    principal: AuthenticatedPrincipal,
    decision: HrDecision,
    cmd: DecisionCommand,
  ): Promise<Result<VacationRequest, WorkflowError>> {
    return this.decide(principal, 'request:approve', cmd, (request, actor, atMs) =>
      decision === 'approve'
        ? request.approve(actor, atMs, cmd.reason)
        : request.rejectAtHr(actor, atMs, cmd.reason),
    );
  }

  // --- Owner withdraw (BR-WF-9) ---

  async withdrawRequest(
    principal: AuthenticatedPrincipal,
    cmd: DecisionCommand,
  ): Promise<Result<VacationRequest, WorkflowError>> {
    return this.decide(
      principal,
      'request:submit',
      cmd,
      (request, actor, atMs) => request.withdraw(actor, atMs, cmd.reason),
      // Withdraw is owner-scoped: the acting principal must own the request.
      { ownerOnly: principal.principalId },
    );
  }

  // --- Reads (feed status-tracking; req-status-tracking) ---

  async getRequest(id: RequestId): Promise<VacationRequest | null> {
    return this.repository.findById(id);
  }

  /**
   * Shared decision pipeline for the two approval stages + withdraw. Loads the
   * aggregate, authorizes against its `{ department, ownerId }` resource, guards
   * concurrency, applies the pure transition, persists, and emits the mapped
   * event. Order matches business-logic-model Workflows B/C and `BR-WF-7`.
   */
  private async decide(
    principal: AuthenticatedPrincipal,
    permission: 'request:validate' | 'request:approve' | 'request:submit',
    cmd: DecisionCommand,
    transition: (
      request: VacationRequest,
      actor: string,
      atMs: number,
    ) => Result<VacationRequest, WorkflowError>,
    scope: { ownerOnly?: string } = {},
  ): Promise<Result<VacationRequest, WorkflowError>> {
    // 1. Load the aggregate first so authorization can be scoped to its resource.
    const request = await this.repository.findById(cmd.requestId);
    if (!request) return err(WorkflowError.notFound());

    // 2. Authorize with the request's department/owner as the ABAC resource.
    const decision = await this.authz.decide(principal, permission, {
      department: request.department,
    });
    if (!decision.ok) return err(WorkflowError.forbidden(decision.error.reason));

    // 2b. Owner-only actions (withdraw) additionally require principal ownership.
    if (scope.ownerOnly !== undefined && request.ownerId !== scope.ownerOnly) {
      return err(WorkflowError.forbidden('PERMISSION_DENIED'));
    }

    // 3. Optimistic concurrency (BR-INV-3): reject a stale expectedVersion
    // before touching state so no partial transition is applied.
    if (request.version !== cmd.expectedVersion) return err(WorkflowError.staleState());

    // 4. Apply the pure transition (state guard, BR-WF-2/6).
    const atMs = this.now();
    const applied = transition(request, principal.principalId, atMs);
    if (!applied.ok) return applied;
    const next = applied.value;

    // 5. Persist (append-only update).
    const saved = await this.repository.save(next);
    if (!saved.ok) return err(saved.error);

    // 6. Emit exactly one event mapped from the new status (BR-INV-5).
    await this.emit(this.eventFor(next, principal.principalId, atMs));
    return ok(next);
  }

  /** Map an accepted transition to its past-tense domain event. */
  private eventFor(request: VacationRequest, actorId: string, atMs: number): WorkflowEvent {
    const base = {
      requestId: request.id,
      ownerId: request.ownerId,
      department: request.department,
      actorId,
      atMs,
    } as const;
    switch (request.status) {
      case 'Validated':
        return { ...base, type: 'RequestValidated', status: 'Validated' };
      case 'Approved':
        return { ...base, type: 'RequestApproved', status: 'Approved' };
      case 'Rejected':
        return {
          ...base,
          type: 'RequestRejected',
          status: 'Rejected',
          rejectedStage: request.rejectedStage ?? 'TeamLead',
        };
      case 'Withdrawn':
        return { ...base, type: 'RequestWithdrawn', status: 'Withdrawn' };
      case 'Submitted':
      default:
        return { ...base, type: 'RequestSubmitted', status: 'Submitted' };
    }
  }

  private async emit(event: WorkflowEvent): Promise<void> {
    await this.events.publish(event);
  }

  /** Validate the submit payload (business-rules `BR-VAL-1..4`). */
  private validateSubmitInput(input: SubmitRequestInput): Result<SubmitRequestInput, WorkflowError> {
    if (!isValidCalendarDate(input.startDate)) return err(WorkflowError.invalidInput('startDate'));
    if (!isValidCalendarDate(input.endDate)) return err(WorkflowError.invalidInput('endDate'));
    // BR-VAL-2: ordering.
    if (input.startDate > input.endDate) return err(WorkflowError.invalidInput('endDate'));
    // BR-VAL-3: not in the past (inclusive whole-day, UTC "today").
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (input.startDate < today) return err(WorkflowError.invalidInput('startDate'));
    // BR-VAL-4: reason length bound.
    if (input.reason !== undefined && input.reason.length > MAX_REASON_LENGTH) {
      return err(WorkflowError.invalidInput('reason'));
    }
    return ok(input);
  }

  private readDepartmentClaim(principal: AuthenticatedPrincipal): string | undefined {
    const raw = (principal.rawClaims as Record<string, unknown>).department;
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  }
}
