/**
 * `VacationRequestRepository` port — anti-corruption boundary over the
 * append-only request store for unit-request-workflow.
 *
 * One repository per aggregate root (DDD repository rule, domain-entities). The
 * store is APPEND-ONLY (`req-constraint-append-only-store`, business-rules
 * `BR-INV-4`): `save` persists the new status + appended history and never
 * overwrites a prior transition record. The interface lives in the domain/ports
 * layer; the in-memory adapter is the dev/test implementation, swappable for a
 * durable append-only store in production behind the same seam (mirrors
 * `SessionStore` / `RoleDirectoryPort` / `BalanceCache`).
 */

import type { Result } from '../../domain/result.js';
import type { WorkflowError } from '../domain/errors.js';
import type { VacationRequest } from '../domain/vacation-request.js';
import type { DepartmentCode, RequestId, RequestStatus } from '../domain/value-objects.js';
import type { PrincipalId } from '../../domain/entities.js';

export interface VacationRequestRepository {
  /**
   * Create-or-append. On create, persists a new aggregate; on update, persists
   * the new status + appended history atomically. Returns `err(STALE_STATE)`
   * when the persisted version does not match the expected prior version
   * (optimistic concurrency, `BR-INV-3`).
   */
  save(request: VacationRequest): Promise<Result<void, WorkflowError>>;

  /** Load a fully-constituted aggregate by id, or null if unknown. */
  findById(id: RequestId): Promise<VacationRequest | null>;

  /** Scoped read: an owner's requests (status-tracking owns rich queries). */
  findByOwner(ownerId: PrincipalId): Promise<readonly VacationRequest[]>;

  /** Scoped read: department requests filtered by status (lead/HR queues). */
  findByDepartmentAndStatus(
    department: DepartmentCode,
    status: RequestStatus,
  ): Promise<readonly VacationRequest[]>;
}
