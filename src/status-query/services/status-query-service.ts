/**
 * `StatusQueryService` — the guarded read/query path for unit-status-query.
 *
 * Realizes the single owned story (`story-status-tracking`) and its requirement
 * (`req-status-tracking`): "track request status across roles". It is the CQRS
 * Query half — a role-scoped, read-only projection over the append-only
 * `VacationRequest` history owned by unit-request-workflow, authorized through
 * the unit-platform-authz PDP.
 *
 * Every query is a GUARDED READ with two halves (business-logic-model, BR-SQ-1..7):
 *   1. Authorization (the who-may-see half) — delegated to `AuthzService.decide`
 *      with the least-privilege view permission for the query shape. A deny
 *      short-circuits with `err(forbidden)` and touches no data (fail closed).
 *   2. Scope filtering (the which-rows half) — a narrow defence-in-depth row
 *      filter using the grant's `departmentScope`; it only ever narrows, never
 *      widens (BR-SQ-5). Out-of-scope rows are OMITTED, never per-row errored
 *      (BR-SQ-7).
 *
 * Reads are PURE (BR-SQ-15): no writes, no transitions, no domain events. Status
 * is DERIVED, never stored here — it is the `to` of the latest transition read
 * through the port (BR-SQ-8). Errors are `Result.err(StatusQueryError)` values,
 * never thrown; PII is never placed in codes/messages (BR-SQ-16).
 *
 * This unit consumes the shipped `VacationRequestRepository` port and
 * `AuthzService` READ-ONLY (domain-entities "Ports"); it defines no persistence
 * of its own.
 */

import { type Result, ok, err } from '../../domain/result.js';
import type { AuthenticatedPrincipal } from '../../domain/entities.js';
import type { AuthzService } from '../../authz/index.js';
import type { Permission } from '../../authz/index.js';
import type { VacationRequestRepository } from '../../workflow/ports/vacation-request-repository.js';
import type { VacationRequest } from '../../workflow/domain/vacation-request.js';
import {
  REQUEST_STATUSES,
  type RequestStatus,
} from '../../workflow/domain/value-objects.js';
import { StatusQueryError } from '../domain/status-query-error.js';
import type {
  RequestSummaryView,
  RequestTimelineView,
  StatusQueryFilter,
  TimelineEntry,
} from '../domain/projections.js';

/**
 * Injected collaborators for the status-query service (hexagonal composition).
 * The only persistence seam is the shipped `VacationRequestRepository`; the only
 * decision collaborator is the shipped `AuthzService`.
 */
export interface StatusQueryServiceDeps {
  readonly repo: VacationRequestRepository;
  readonly authz: AuthzService;
}

/** Default statuses surfaced by a scoped queue when no explicit filter is given. */
const LEAD_DEFAULT_STATUSES: readonly RequestStatus[] = ['Submitted'];
const HR_DEFAULT_STATUSES: readonly RequestStatus[] = ['Validated'];

export class StatusQueryService {
  private readonly repo: VacationRequestRepository;
  private readonly authz: AuthzService;

  constructor(deps: StatusQueryServiceDeps) {
    this.repo = deps.repo;
    this.authz = deps.authz;
  }

  // --- Query A: list my requests (story-status-tracking) ---

  /**
   * List an employee's own request summaries. Self-scoped authorization
   * (`request:view-own`), then owner-scoped load, then a defence-in-depth owner
   * re-assertion (BR-SQ-5), optional status filter (BR-SQ-12), projection, and
   * deterministic ordering by `lastUpdatedAtMs` desc (BR-SQ-10).
   */
  async listOwnRequests(
    principal: AuthenticatedPrincipal,
    filter?: StatusQueryFilter,
  ): Promise<Result<readonly RequestSummaryView[], StatusQueryError>> {
    // Validate the optional status filter first (BR-SQ-12).
    const validated = this.validateFilter(filter);
    if (!validated.ok) return validated;

    // 1. Authorize (fail closed, BR-SQ-1/2).
    const decision = await this.authz.decide(principal, 'request:view-own');
    if (!decision.ok) return err(StatusQueryError.forbidden(decision.error.reason));

    // 2. Load owner-scoped candidates.
    const candidates = await this.repo.findByOwner(principal.principalId);

    // 3. Defence-in-depth: re-assert owner identity (BR-SQ-5).
    let rows = candidates.filter((r) => r.ownerId === principal.principalId);

    // 4. Optional status filter.
    if (validated.value?.status !== undefined) {
      rows = rows.filter((r) => r.status === validated.value?.status);
    }

    // 5-6. Project + order (most-recently-changed first, BR-SQ-10).
    const views = rows.map((r) => this.toSummaryView(r));
    views.sort((a, b) => b.lastUpdatedAtMs - a.lastUpdatedAtMs);
    return ok(views);
  }

  // --- Query B: list a scoped queue (req-status-tracking) ---

  /**
   * List a team-lead queue (own team) or an HR department view (in-scope
   * department). The `role` intent chooses the least-privilege permission
   * (BR-SQ-2); the PDP arbitrates scope (BR-SQ-3). A `department` is required
   * (BR-SQ-13). Results are filtered defence-in-depth against the grant's
   * `departmentScope` (BR-SQ-5) and ordered per BR-SQ-10 (lead: oldest-first;
   * HR: most-recently-changed first).
   */
  async listScopedRequests(
    principal: AuthenticatedPrincipal,
    role: 'team-lead' | 'hr',
    department: string,
    filter?: StatusQueryFilter,
  ): Promise<Result<readonly RequestSummaryView[], StatusQueryError>> {
    // Validate required department (BR-SQ-13) and optional status filter (BR-SQ-12).
    if (typeof department !== 'string' || department.length === 0) {
      return err(StatusQueryError.invalidInput('department'));
    }
    const validated = this.validateFilter(filter);
    if (!validated.ok) return validated;

    // 1. Least-privilege permission by intent (BR-SQ-2).
    const permission: Permission =
      role === 'team-lead' ? 'request:view-team' : 'request:view-department';

    // 2. Authorize with `{ department }` as the ABAC resource (BR-SQ-1/3).
    const decision = await this.authz.decide(principal, permission, { department });
    if (!decision.ok) return err(StatusQueryError.forbidden(decision.error.reason));

    // 3. Load candidates: a given status filter is a single query; otherwise a
    //    union over the queue's default visible statuses (BR-SQ-12).
    const statuses =
      validated.value?.status !== undefined
        ? [validated.value.status]
        : role === 'team-lead'
          ? LEAD_DEFAULT_STATUSES
          : HR_DEFAULT_STATUSES;

    const loaded = await this.loadByDepartmentAndStatuses(department, statuses);

    // 4. Defence-in-depth scope filter (HR): keep rows whose department is within
    //    the grant scope. For team-lead the grant carries no department scope —
    //    the PDP's own-team predicate already scoped the permit (BR-SQ-5).
    const scope = decision.value.departmentScope;
    const rows =
      role === 'hr' && scope.length > 0
        ? loaded.filter((r) => scope.includes(r.department))
        : loaded;

    // 5-6. Project + order (BR-SQ-10).
    const views = rows.map((r) => this.toSummaryView(r));
    if (role === 'team-lead') {
      views.sort((a, b) => a.submittedAtMs - b.submittedAtMs); // oldest waiting first
    } else {
      views.sort((a, b) => b.lastUpdatedAtMs - a.lastUpdatedAtMs);
    }
    return ok(views);
  }

  // --- Query C: get one request status + timeline (req-status-tracking) ---

  /**
   * Get one request's current status + append-only timeline. Ordered fail-closed
   * (business-logic-model Query C): load by id (not-found before any authz leak),
   * choose the least-privilege permission from the caller's relationship to the
   * request (owner → view-own; else view-team/view-department by role), authorize
   * with the request's department as the ABAC resource, then project the history
   * to a chronological timeline (BR-SQ-11). Reasons are included for the
   * authorized caller (BR-SQ-6) — an unauthorized caller never reaches this point.
   */
  async getRequestTimeline(
    principal: AuthenticatedPrincipal,
    requestId: string,
  ): Promise<Result<RequestTimelineView, StatusQueryError>> {
    // Validate required id (BR-SQ-14).
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return err(StatusQueryError.invalidInput('requestId'));
    }

    // 1. Load by id. Unknown id → notFound (BR-SQ-4).
    const request = await this.repo.findById(requestId);
    if (!request) return err(StatusQueryError.notFound());

    // 2. Choose the least-privilege permission that could authorize this read.
    const isOwner = request.ownerId === principal.principalId;
    const decision = isOwner
      ? await this.authz.decide(principal, 'request:view-own')
      : await this.authorizeNonOwnerRead(principal, request.department);

    // 3. A deny never confirms existence to an out-of-scope caller (BR-SQ-4).
    if (!decision.ok) return err(StatusQueryError.forbidden(decision.error.reason));

    // 4. Project the append-only history → chronological timeline (BR-SQ-11).
    return ok(this.toTimelineView(request));
  }

  // --- Internals ---

  /**
   * Authorize a non-owner read by trying the two scoped view permissions. The
   * PDP is the arbiter of which (if any) the caller's role grants; the first
   * permit wins. Both denials collapse to a single forbidden (fail closed) —
   * the caller's role decides, this unit never re-derives it (BR-SQ-3).
   */
  private async authorizeNonOwnerRead(
    principal: AuthenticatedPrincipal,
    department: string,
  ) {
    const asLead = await this.authz.decide(principal, 'request:view-team', { department });
    if (asLead.ok) return asLead;
    return this.authz.decide(principal, 'request:view-department', { department });
  }

  /** Load and de-duplicate department rows across a set of statuses. */
  private async loadByDepartmentAndStatuses(
    department: string,
    statuses: readonly RequestStatus[],
  ): Promise<readonly VacationRequest[]> {
    const byId = new Map<string, VacationRequest>();
    for (const status of statuses) {
      const batch = await this.repo.findByDepartmentAndStatus(department, status);
      for (const request of batch) byId.set(request.id, request);
    }
    return [...byId.values()];
  }

  /** Project an aggregate to its compact, reason-free summary row (BR-SQ-9). */
  private toSummaryView(request: VacationRequest): RequestSummaryView {
    const history = request.history;
    const submittedAtMs = history.length > 0 ? history[0].atMs : 0;
    const lastUpdatedAtMs = history.length > 0 ? history[history.length - 1].atMs : submittedAtMs;
    const state = request.toState();
    return {
      id: request.id,
      status: request.status,
      dates: state.dates,
      submittedAtMs,
      lastUpdatedAtMs,
      ...(request.rejectedStage !== undefined ? { rejectedStage: request.rejectedStage } : {}),
    };
  }

  /**
   * Project an aggregate to its single-request detail view: current status + the
   * full chronological timeline (BR-SQ-11). Each entry carries the role-gated
   * `reason` (BR-SQ-6) — included here because the caller is already authorized
   * for this request.
   */
  private toTimelineView(request: VacationRequest): RequestTimelineView {
    const state = request.toState();
    const timeline: TimelineEntry[] = request.history.map((t) => ({
      from: t.from,
      to: t.to,
      atMs: t.atMs,
      ...(t.to === 'Rejected' && request.rejectedStage !== undefined
        ? { stage: request.rejectedStage }
        : {}),
      ...(t.reason !== undefined ? { reason: t.reason } : {}),
    }));
    return {
      id: request.id,
      status: request.status,
      dates: state.dates,
      department: request.department,
      version: request.version,
      ...(request.rejectedStage !== undefined ? { rejectedStage: request.rejectedStage } : {}),
      timeline,
    };
  }

  /**
   * Validate the optional status filter (BR-SQ-12): a provided `status` must be
   * one of the closed `RequestStatus` members; absent means "all visible".
   */
  private validateFilter(
    filter?: StatusQueryFilter,
  ): Result<StatusQueryFilter | undefined, StatusQueryError> {
    if (filter?.status === undefined) return ok(filter);
    if (!(REQUEST_STATUSES as readonly string[]).includes(filter.status)) {
      return err(StatusQueryError.invalidInput('status'));
    }
    return ok(filter);
  }
}
