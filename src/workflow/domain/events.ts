/**
 * Domain events for unit-request-workflow (domain-entities Domain Events;
 * business-rules `BR-INV-5` event-per-transition).
 *
 * Past-tense facts, exactly one per accepted transition, emitted in the same
 * logical commit as the state change so no transition is unaudited or
 * un-notified. Consumers (`audit-trail`, `notification`, `overlap-indicator`)
 * subscribe via choreography — this unit never calls them directly.
 *
 * PII (`req-nfr-security-pii`, `BR-INV-6`): payloads carry only pseudonymous ids
 * (requestId, ownerId, actorId) + department + status + timestamp — never
 * free-text reason material or subject email.
 */

import type { PrincipalId } from '../../domain/entities.js';
import type { DepartmentCode, RequestId, RequestStatus, WorkflowStage } from './value-objects.js';

export type WorkflowEventType =
  | 'RequestSubmitted'
  | 'RequestValidated'
  | 'RequestApproved'
  | 'RequestRejected'
  | 'RequestWithdrawn';

/** Common shape shared by every workflow domain event. */
interface WorkflowEventBase {
  readonly type: WorkflowEventType;
  readonly requestId: RequestId;
  readonly ownerId: PrincipalId;
  readonly department: DepartmentCode;
  readonly actorId: PrincipalId;
  readonly status: RequestStatus;
  readonly atMs: number;
}

export interface RequestSubmitted extends WorkflowEventBase {
  readonly type: 'RequestSubmitted';
  readonly status: 'Submitted';
}
export interface RequestValidated extends WorkflowEventBase {
  readonly type: 'RequestValidated';
  readonly status: 'Validated';
}
export interface RequestApproved extends WorkflowEventBase {
  readonly type: 'RequestApproved';
  readonly status: 'Approved';
}
export interface RequestRejected extends WorkflowEventBase {
  readonly type: 'RequestRejected';
  readonly status: 'Rejected';
  /** Which stage rejected (business-rules `BR-WF-5`). */
  readonly rejectedStage: WorkflowStage;
}
export interface RequestWithdrawn extends WorkflowEventBase {
  readonly type: 'RequestWithdrawn';
  readonly status: 'Withdrawn';
}

export type WorkflowEvent =
  | RequestSubmitted
  | RequestValidated
  | RequestApproved
  | RequestRejected
  | RequestWithdrawn;
