/**
 * Recipient policy for unit-notifications.
 *
 * Grounded in `business-rules` (`BR-NOTIF-1..5`): the pure mapping from a
 * consumed `WorkflowEvent` to the set of recipients that must be notified. The
 * request owner is always a recipient (`BR-NOTIF-2`); the next actor (team lead
 * on submit, HR on validate) is notified so the two-stage workflow is an
 * actionable pipeline (`BR-NOTIF-3`). Approver copies on terminal events are
 * optional/configurable (`BR-NOTIF-5`).
 *
 * This module holds NO I/O — recipients are described as `RecipientTarget`
 * descriptors (a principal id, or a role-in-department the directory resolves).
 * The `NotificationService` resolves them to contacts at send time.
 */

import type { PrincipalId } from '../../domain/entities.js';
import type { WorkflowEvent } from '../../workflow/domain/events.js';
import type { DepartmentCode } from '../../workflow/domain/value-objects.js';

/** A directory-resolvable role within a department (`BR-NOTIF-3`). */
export type DirectoryRole = 'team-lead' | 'hr';

/**
 * A recipient to notify. Either a concrete principal (the owner / a known
 * actor) or a role-in-department the directory resolves (the next actor).
 */
export type RecipientTarget =
  | { readonly kind: 'principal'; readonly principalId: PrincipalId; readonly required: boolean }
  | { readonly kind: 'role'; readonly role: DirectoryRole; readonly department: DepartmentCode; readonly required: boolean };

/**
 * Configuration for optional approver/actor copies (`BR-NOTIF-5`). The owner
 * copy is never optional. Defaults keep the actionable-pipeline recipients
 * (next actor) required and the terminal actor copies off.
 */
export interface RecipientPolicyConfig {
  /** Copy the rejecting/approving actor on terminal events (default false). */
  readonly copyActorOnTerminal: boolean;
  /** Copy the team lead when an owner withdraws (default false). */
  readonly copyLeadOnWithdrawn: boolean;
}

export const DEFAULT_RECIPIENT_POLICY: RecipientPolicyConfig = {
  copyActorOnTerminal: false,
  copyLeadOnWithdrawn: false,
};

/**
 * Map a workflow event to its recipient set (`BR-NOTIF-1..5`). Pure and total
 * over the five known event types; the caller treats an unknown type as a
 * no-op (fail-closed recipient policy, `business-rules` Validation & Edge
 * Cases).
 */
export function recipientsFor(
  event: WorkflowEvent,
  config: RecipientPolicyConfig = DEFAULT_RECIPIENT_POLICY,
): readonly RecipientTarget[] {
  const owner: RecipientTarget = { kind: 'principal', principalId: event.ownerId, required: true };

  switch (event.type) {
    case 'RequestSubmitted':
      // Owner (confirmation) + team lead (action needed) — BR-NOTIF-3.
      return [owner, { kind: 'role', role: 'team-lead', department: event.department, required: true }];
    case 'RequestValidated':
      // Owner (progress) + HR (action needed) — BR-NOTIF-3.
      return [owner, { kind: 'role', role: 'hr', department: event.department, required: true }];
    case 'RequestApproved':
      // Owner (outcome); approver copy optional — BR-NOTIF-5.
      return config.copyActorOnTerminal
        ? [owner, { kind: 'principal', principalId: event.actorId, required: false }]
        : [owner];
    case 'RequestRejected':
      // Owner (outcome, with stage); rejecting actor copy optional — BR-NOTIF-5.
      return config.copyActorOnTerminal
        ? [owner, { kind: 'principal', principalId: event.actorId, required: false }]
        : [owner];
    case 'RequestWithdrawn':
      // Owner (confirmation); team lead copy optional — BR-NOTIF-5.
      return config.copyLeadOnWithdrawn
        ? [owner, { kind: 'role', role: 'team-lead', department: event.department, required: false }]
        : [owner];
    default:
      // Unknown / unmapped event type — no recipients (fail-closed no-op).
      return [];
  }
}
