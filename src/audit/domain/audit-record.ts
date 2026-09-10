/**
 * Domain entity, value objects, and error type for unit-audit-trail.
 *
 * Grounded in domain-entities (Entities & Value Objects) and business-rules
 * (`BR-AUD-1a/1b`, `BR-AUD-5a`, `BR-AUD-6`, `BR-AUD-7`, `BR-AUD-8`). This unit
 * owns exactly one entity — the immutable `AuditRecord` — plus its supporting
 * value objects. Identity, RBAC, and the `VacationRequest` aggregate are NOT
 * redefined here: `RequestId`, `DepartmentCode`, `RequestStatus`,
 * `WorkflowStage` are reused read-only from unit-request-workflow and
 * `PrincipalId` from unit-platform-auth (conformist-with-ACL boundary).
 *
 * PII posture (business-rules `BR-AUD-8`, req-nfr-security-pii): a record holds
 * only the pseudonymous ids and non-PII fields the inbound `WorkflowEvent`
 * already carries — never email, name, or free-text reason material.
 */

import type { PrincipalId } from '../../domain/entities.js';
import type {
  DepartmentCode,
  RequestId,
  RequestStatus,
  WorkflowStage,
} from '../../workflow/domain/value-objects.js';
import { canonicalSerialize, sha256Hex } from './canonical.js';

/** Opaque, unique identifier of a single audit record (UUID string). */
export type AuditId = string;

/** SHA-256 digest (hex) of a record's canonical serialization (`BR-AUD-6`). */
export type RecordHash = string;

/** Reserved sentinel used as the `prevHash` of the first record in a partition. */
export const GENESIS: RecordHash = 'GENESIS';

/** Seven-year retention window in milliseconds (`BR-AUD-7`, req-nfr-audit-retention). */
export const SEVEN_YEARS_MS = 7 * 365 * 24 * 60 * 60 * 1000;

/**
 * Audit event types — mirror the shipped workflow `WorkflowEventType` verbatim
 * (domain-entities `EventType`); consumed from the published event language,
 * never re-invented.
 */
export const EVENT_TYPES = [
  'RequestSubmitted',
  'RequestValidated',
  'RequestApproved',
  'RequestRejected',
  'RequestWithdrawn',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Type guard for the closed audit event-type set (`BR-AUD-1`). */
export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}

/** Machine-readable, PII-free failure codes (domain-entities `AuditError`). */
export type AuditErrorCode = 'MALFORMED_EVENT' | 'INTEGRITY_VIOLATION' | 'NOT_FOUND';

/** Kind of integrity failure detected by `verifyChain` (`BR-AUD-6`). */
export type IntegrityKind = 'hash-mismatch' | 'broken-link';

/**
 * Value-level failure for the audit boundary. Returned inside
 * `Result<T, AuditError>` — never thrown (throwing is reserved for
 * infrastructure/programmer error), mirroring `SsoError` / `AuthzError` /
 * `HrisError` / `WorkflowError`. The message is always PII-free.
 */
export class AuditError extends Error {
  readonly code: AuditErrorCode;
  readonly field?: string;
  readonly auditId?: AuditId;
  readonly kind?: IntegrityKind;

  private constructor(
    code: AuditErrorCode,
    message: string,
    extra: { field?: string; auditId?: AuditId; kind?: IntegrityKind } = {},
  ) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    if (extra.field !== undefined) this.field = extra.field;
    if (extra.auditId !== undefined) this.auditId = extra.auditId;
    if (extra.kind !== undefined) this.kind = extra.kind;
    Object.setPrototypeOf(this, AuditError.prototype);
  }

  /** A required field was missing/ill-formed on the inbound event (`BR-AUD-1`). */
  static malformedEvent(field: string): AuditError {
    return new AuditError('MALFORMED_EVENT', 'The audit event is malformed.', { field });
  }

  /** The hash chain was broken or a record's hash did not recompute (`BR-AUD-6`). */
  static integrityViolation(auditId: AuditId, kind: IntegrityKind): AuditError {
    return new AuditError('INTEGRITY_VIOLATION', 'Audit chain integrity check failed.', {
      auditId,
      kind,
    });
  }

  /** No audit record matched the query. */
  static notFound(): AuditError {
    return new AuditError('NOT_FOUND', 'No audit records were found.');
  }
}

/**
 * Read filter value object for `queryTrail` (domain-entities `TrailQuery`).
 * All fields optional — an empty filter returns the whole trail (subject to the
 * auditor's scope).
 */
export interface TrailQuery {
  readonly department?: DepartmentCode;
  readonly eventType?: EventType;
  readonly actorId?: PrincipalId;
  readonly fromMs?: number;
  readonly toMs?: number;
}

/**
 * The immutable fields of an audit record. Split out so the hash can be
 * computed over exactly "all fields except `hash`" (`BR-AUD-6`).
 */
export interface AuditRecordFields {
  readonly auditId: AuditId;
  readonly eventType: EventType;
  readonly requestId: RequestId;
  readonly ownerId: PrincipalId;
  readonly department: DepartmentCode;
  readonly actorId: PrincipalId;
  readonly resultingState: RequestStatus;
  readonly rejectedStage?: WorkflowStage;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
  readonly prevHash: RecordHash;
  readonly retainUntilMs: number;
}

/**
 * An immutable, append-only audit fact — the unit's only entity
 * (domain-entities `AuditRecord`). Once constructed it never changes
 * (`BR-AUD-5a`): all fields are `readonly` and the instance is frozen. It has
 * NO mutating methods and performs NO I/O.
 */
export interface AuditRecord extends AuditRecordFields {
  /** This record's own SHA-256 digest over its canonical serialization. */
  readonly hash: RecordHash;
}

/** The event shape this unit consumes (structural subset of `WorkflowEvent`). */
export interface AuditableEvent {
  readonly type: EventType;
  readonly requestId: RequestId;
  readonly ownerId: PrincipalId;
  readonly department: DepartmentCode;
  readonly actorId: PrincipalId;
  readonly status: RequestStatus;
  readonly atMs: number;
  readonly rejectedStage?: WorkflowStage;
}

/** The canonical-serializer version tag baked into every hash input (`BR-AUD-6a`). */
export const HASH_VERSION = 'v1';

/**
 * Pure factory: build an immutable `AuditRecord` from a validated event, the
 * partition's current chain head, and the ingest clock. Computes `hash` and
 * `retainUntilMs`. No I/O. (`business-logic-model` step 4; `BR-AUD-6`, `BR-AUD-7`.)
 */
export function createAuditRecord(
  event: AuditableEvent,
  prevHash: RecordHash,
  recordedAtMs: number,
  newId: () => AuditId,
): AuditRecord {
  const fields: AuditRecordFields = {
    auditId: newId(),
    eventType: event.type,
    requestId: event.requestId,
    ownerId: event.ownerId,
    department: event.department,
    actorId: event.actorId,
    resultingState: event.status,
    ...(event.rejectedStage !== undefined ? { rejectedStage: event.rejectedStage } : {}),
    occurredAtMs: event.atMs,
    recordedAtMs,
    prevHash,
    retainUntilMs: recordedAtMs + SEVEN_YEARS_MS,
  };
  const hash = hashOf(fields);
  return Object.freeze({ ...fields, hash });
}

/**
 * Recompute the hash of a record's fields — used by `verifyChain` to detect
 * tampering (`BR-AUD-6`). Pure and deterministic (`BR-AUD-6a`).
 */
export function recomputeHash(record: AuditRecord): RecordHash {
  return hashOf(toFields(record));
}

/** Hash over all fields except `hash`, version-tagged (`BR-AUD-6a`). */
function hashOf(fields: AuditRecordFields): RecordHash {
  return sha256Hex(canonicalSerialize({ v: HASH_VERSION, ...fields }));
}

/** Strip the `hash` field to obtain the hashable field set. */
function toFields(record: AuditRecord): AuditRecordFields {
  const {
    auditId,
    eventType,
    requestId,
    ownerId,
    department,
    actorId,
    resultingState,
    rejectedStage,
    occurredAtMs,
    recordedAtMs,
    prevHash,
    retainUntilMs,
  } = record;
  return {
    auditId,
    eventType,
    requestId,
    ownerId,
    department,
    actorId,
    resultingState,
    ...(rejectedStage !== undefined ? { rejectedStage } : {}),
    occurredAtMs,
    recordedAtMs,
    prevHash,
    retainUntilMs,
  };
}
