/**
 * `AuditService` — the immutable audit trail's ingest + query + integrity core
 * (unit-audit-trail, story-immutable-audit).
 *
 * Realizes the four workflows from business-logic-model:
 *  - `recordEvent`     — validate → dedup → chain → append one AuditRecord
 *  - `getRequestTrail` — ordered read of a request's sub-chain
 *  - `queryTrail`      — filtered read
 *  - `verifyChain`     — pure tamper-evidence walk
 *
 * The unit is a choreography side-effect consumer (services topology): it
 * subscribes to the workflow's published `WorkflowEvent` stream via the
 * `EventPublisher` port and NEVER calls the workflow unit back. An inbound ACL
 * mapper isolates the audit record shape from event-shape drift.
 *
 * Error handling follows the shipped `Result<T,E>` convention: expected
 * failures (malformed event, integrity violation, not found) are VALUES, never
 * thrown (business-logic-model error-handling; `BR-AUD-1`, `BR-AUD-6`).
 *
 * PII (`BR-AUD-8`, req-nfr-security-pii): the service copies only the
 * pseudonymous ids and non-PII fields the event carries; it never enriches with
 * subject PII, and its error codes/messages are PII-free.
 */

import type { Result } from '../../domain/result.js';
import { ok, err } from '../../domain/result.js';
import type { WorkflowEvent } from '../../workflow/domain/events.js';
import type { AuditStore } from '../ports/audit-store.js';
import {
  type AuditableEvent,
  type AuditId,
  type AuditRecord,
  type EventType,
  type TrailQuery,
  AuditError,
  GENESIS,
  createAuditRecord,
  isEventType,
  recomputeHash,
} from '../domain/audit-record.js';
import { newAuditId } from '../domain/canonical.js';

export interface AuditServiceDeps {
  readonly store: AuditStore;
  /** Ingest clock; injectable for deterministic tests. */
  readonly clock?: () => number;
  /** Audit-id factory; injectable for deterministic tests. */
  readonly idFactory?: () => AuditId;
}

/** The five statuses each event type is allowed to record (`BR-AUD-1a`). */
const STATUS_FOR_TYPE: Record<EventType, string> = {
  RequestSubmitted: 'Submitted',
  RequestValidated: 'Validated',
  RequestApproved: 'Approved',
  RequestRejected: 'Rejected',
  RequestWithdrawn: 'Withdrawn',
};

export class AuditService {
  private readonly store: AuditStore;
  private readonly now: () => number;
  private readonly newId: () => AuditId;

  constructor(deps: AuditServiceDeps) {
    this.store = deps.store;
    this.now = deps.clock ?? Date.now;
    this.newId = deps.idFactory ?? newAuditId;
  }

  /**
   * Record one immutable AuditRecord per accepted transition. Idempotent: a
   * duplicate delivery (same dedup key) returns the already-stored record and
   * appends nothing (`BR-AUD-2`). Malformed events fail closed with no write
   * (`BR-AUD-1`).
   */
  async recordEvent(event: WorkflowEvent): Promise<Result<AuditRecord, AuditError>> {
    const validated = this.validate(event);
    if (!validated.ok) return validated;
    const auditable = validated.value;

    // Idempotency: dedup by (eventType, requestId, occurredAtMs) (`BR-AUD-2`).
    const existing = await this.store.findByKey(
      auditable.type,
      auditable.requestId,
      auditable.atMs,
    );
    if (existing) return ok(existing);

    // Per-request chain partition (`BR-AUD-4`): link to the current head or GENESIS.
    const head = await this.store.chainHead(auditable.requestId);
    const prevHash = head ?? GENESIS;

    const record = createAuditRecord(auditable, prevHash, this.now(), this.newId);
    await this.store.append(record); // append-only; infra failure rejects the promise
    return ok(record);
  }

  /** Ordered read of a request's audit sub-chain (empty list is a valid answer). */
  async getRequestTrail(requestId: string): Promise<Result<AuditRecord[], AuditError>> {
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      return err(AuditError.malformedEvent('requestId'));
    }
    const records = await this.store.findByRequest(requestId);
    return ok(records);
  }

  /** Filtered read; append order preserved (`BR-AUD-9` — non-mutating). */
  async queryTrail(filter: TrailQuery): Promise<Result<AuditRecord[], AuditError>> {
    const records = await this.store.query(filter ?? {});
    return ok(records);
  }

  /**
   * Pure, side-effect-free integrity walk (`BR-AUD-6`, `BR-AUD-9`). Recomputes
   * each record's hash and checks each partition link; any mismatch or broken
   * link yields `AuditError.integrityViolation(auditId, kind)`.
   */
  async verifyChain(requestId: string): Promise<Result<void, AuditError>> {
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      return err(AuditError.malformedEvent('requestId'));
    }
    const records = await this.store.findByRequest(requestId);
    let expectedPrev = GENESIS;
    for (const record of records) {
      if (recomputeHash(record) !== record.hash) {
        return err(AuditError.integrityViolation(record.auditId, 'hash-mismatch'));
      }
      if (record.prevHash !== expectedPrev) {
        return err(AuditError.integrityViolation(record.auditId, 'broken-link'));
      }
      expectedPrev = record.hash;
    }
    return ok(undefined);
  }

  /**
   * Inbound ACL: validate the published event shape (`BR-AUD-1`) and project it
   * to the internal `AuditableEvent`. Fail-closed on any malformed field so an
   * unrecordable event never silently vanishes and never corrupts the chain.
   */
  private validate(event: WorkflowEvent): Result<AuditableEvent, AuditError> {
    if (!event || typeof event !== 'object') {
      return err(AuditError.malformedEvent('event'));
    }
    if (!isEventType(event.type)) return err(AuditError.malformedEvent('type'));

    const requiredStrings: [keyof WorkflowEvent, string][] = [
      ['requestId', event.requestId],
      ['ownerId', event.ownerId],
      ['department', event.department],
      ['actorId', event.actorId],
      ['status', event.status],
    ] as [keyof WorkflowEvent, string][];
    for (const [field, value] of requiredStrings) {
      if (typeof value !== 'string' || value.trim() === '') {
        return err(AuditError.malformedEvent(field as string));
      }
    }

    if (
      typeof event.atMs !== 'number' ||
      !Number.isFinite(event.atMs) ||
      event.atMs < 0
    ) {
      return err(AuditError.malformedEvent('atMs'));
    }

    // Status/type consistency (`BR-AUD-1a`).
    if (STATUS_FOR_TYPE[event.type] !== event.status) {
      return err(AuditError.malformedEvent('status'));
    }

    // `rejectedStage` present iff RequestRejected (`BR-AUD-1b`).
    const hasStage = 'rejectedStage' in event && event.rejectedStage !== undefined;
    if (event.type === 'RequestRejected') {
      if (!hasStage) return err(AuditError.malformedEvent('rejectedStage'));
    } else if (hasStage) {
      return err(AuditError.malformedEvent('rejectedStage'));
    }

    const auditable: AuditableEvent = {
      type: event.type,
      requestId: event.requestId,
      ownerId: event.ownerId,
      department: event.department,
      actorId: event.actorId,
      status: event.status,
      atMs: event.atMs,
      ...(event.type === 'RequestRejected'
        ? { rejectedStage: event.rejectedStage }
        : {}),
    };
    return ok(auditable);
  }
}
