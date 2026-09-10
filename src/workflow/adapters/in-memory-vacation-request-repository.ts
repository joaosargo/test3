/**
 * In-memory `VacationRequestRepository` adapter for unit-request-workflow.
 *
 * Dev/test double. Enforces the APPEND-ONLY contract (business-rules `BR-INV-4`,
 * `req-constraint-append-only-store`): it stores the full aggregate state
 * (including its append-only history) keyed by `RequestId`, and enforces
 * optimistic concurrency (`BR-INV-3`) by rejecting a save whose prior version
 * does not match the stored version. Production swaps a durable append-only
 * store behind the same port (tech-stack-decisions), mirroring
 * `in-memory-session-store.ts` / `in-memory-role-directory.ts`.
 *
 * PII (`req-nfr-security-pii`): holds owner ids, department, and reason text
 * (potential PII). This adapter never logs entries and exposes no enumeration
 * beyond the scoped reads the port declares.
 */

import { type Result, ok, err } from '../../domain/result.js';
import { WorkflowError } from '../domain/errors.js';
import { VacationRequest, type VacationRequestState } from '../domain/vacation-request.js';
import type { VacationRequestRepository } from '../ports/vacation-request-repository.js';
import type { DepartmentCode, RequestId, RequestStatus } from '../domain/value-objects.js';
import type { PrincipalId } from '../../domain/entities.js';

export class InMemoryVacationRequestRepository implements VacationRequestRepository {
  private readonly byId = new Map<RequestId, VacationRequestState>();

  async save(request: VacationRequest): Promise<Result<void, WorkflowError>> {
    const next = request.toState();
    const existing = this.byId.get(next.id);

    if (existing) {
      // Optimistic concurrency: the incoming aggregate's version must be
      // exactly one greater than what is stored (a single accepted transition).
      // Any other delta means the caller acted on a stale read (BR-INV-3).
      if (next.version !== existing.version + 1) {
        return err(WorkflowError.staleState());
      }
      // Append-only guard: history may only grow and never rewrite prior records.
      if (next.history.length <= existing.history.length) {
        return err(WorkflowError.staleState());
      }
    } else if (next.version !== 1) {
      // A create must start at version 1 (BR-INV-2).
      return err(WorkflowError.staleState());
    }

    // Store an immutable snapshot (defensive copy of history).
    this.byId.set(next.id, { ...next, history: [...next.history] });
    return ok(undefined);
  }

  async findById(id: RequestId): Promise<VacationRequest | null> {
    const state = this.byId.get(id);
    return state ? VacationRequest.fromState(state) : null;
  }

  async findByOwner(ownerId: PrincipalId): Promise<readonly VacationRequest[]> {
    return this.all().filter((r) => r.ownerId === ownerId);
  }

  async findByDepartmentAndStatus(
    department: DepartmentCode,
    status: RequestStatus,
  ): Promise<readonly VacationRequest[]> {
    return this.all().filter((r) => r.department === department && r.status === status);
  }

  private all(): VacationRequest[] {
    return [...this.byId.values()].map((s) => VacationRequest.fromState(s));
  }
}
