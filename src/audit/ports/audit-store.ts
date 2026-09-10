/**
 * `AuditStore` port — append-only persistence for unit-audit-trail.
 *
 * Grounded in domain-entities (Ports → `AuditStore`) and business-rules
 * `BR-AUD-5` (`req-constraint-append-only-store`): the port exposes `append`
 * and READ operations ONLY. There is deliberately **no `update` and no
 * `delete`** — immutability is a contract-level guarantee (code that attempts
 * to mutate a record cannot compile against this port), not merely an
 * operational policy.
 *
 * The in-memory adapter is the dev/test implementation; production swaps a
 * durable append-only / WORM store behind the same seam (infrastructure-design
 * owns the choice), exactly as `SessionStore`, `RoleDirectoryPort`,
 * `BalanceCache`, and `VacationRequestRepository` do.
 */

import type { AuditRecord, RecordHash, TrailQuery } from '../domain/audit-record.js';

export interface AuditStore {
  /**
   * The ONLY write operation. Appends an immutable record; never overwrites.
   * Rejects only on infrastructure failure (caller treats as an infra error).
   */
  append(record: AuditRecord): Promise<void>;

  /**
   * Idempotency support (`BR-AUD-2`): return the existing record for the dedup
   * key `(eventType, requestId, occurredAtMs)`, or `null` if none exists.
   */
  findByKey(
    eventType: AuditRecord['eventType'],
    requestId: AuditRecord['requestId'],
    occurredAtMs: number,
  ): Promise<AuditRecord | null>;

  /**
   * Current chain-head hash for a request partition (`BR-AUD-4`), or `null`
   * when the partition is empty (first record links to `GENESIS`).
   */
  chainHead(requestId: AuditRecord['requestId']): Promise<RecordHash | null>;

  /**
   * Ordered partition read for `getRequestTrail` and `verifyChain`. Returns
   * records in append (chain) order.
   */
  findByRequest(requestId: AuditRecord['requestId']): Promise<AuditRecord[]>;

  /** Filtered read for `queryTrail`; append order preserved. */
  query(filter: TrailQuery): Promise<AuditRecord[]>;
}
