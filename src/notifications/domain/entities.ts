/**
 * Notification entities for unit-notifications.
 *
 * Grounded in functional-design `domain-entities` (Entities & Aggregates). Two
 * concepts no other unit models:
 *   - `InAppNotification`: the persisted in-app copy a recipient sees; mutable
 *     only in its read/unread flag (`markRead` is idempotent).
 *   - `NotificationDelivery`: an APPEND-ONLY operational record — one per
 *     `(recipient, event)` handling pass — the idempotency + dead-letter
 *     reconciliation surface (`BR-NOTIF-11`), distinct from the compliance
 *     `audit-trail` owned by another unit.
 *
 * Cross-unit references are ids (`RequestId`, `PrincipalId`), not object graphs,
 * matching the least-coupling boundary the workflow/authz units established.
 */

import type { PrincipalId } from '../../domain/entities.js';
import type { RequestId } from '../../workflow/domain/value-objects.js';
import type { WorkflowEventType } from '../../workflow/domain/events.js';
import type { ChannelOutcome, DedupeKey, NotificationId } from './value-objects.js';

/**
 * Persisted in-app notification (`domain-entities` `InAppNotification`).
 * Identity by `NotificationId`; only `read` mutates after creation.
 */
export interface InAppNotification {
  readonly id: NotificationId;
  /** Whose inbox — the self-scope key (`BR-NOTIF-12`). */
  readonly recipientId: PrincipalId;
  /** The vacation request this is about (id ref, not object). */
  readonly requestId: RequestId;
  /** Which transition triggered it. */
  readonly eventType: WorkflowEventType;
  /** Rendered, PII-minimal in-app headline. */
  readonly title: string;
  /** Rendered text; encrypted at rest if it embeds PII (`BR-PII-3`). */
  readonly body: string;
  /** Idempotency token (`BR-NOTIF-9`). */
  readonly dedupeKey: DedupeKey;
  /** Unread by default; `markRead` sets true (idempotent). */
  readonly read: boolean;
  /** Epoch ms of creation. */
  readonly createdAtMs: number;
}

/**
 * Append-only operational record (`domain-entities` `NotificationDelivery`).
 * Write-once, never mutated (`BR-NOTIF-11`). Carries only PII-free ids and
 * per-channel outcomes (`BR-PII-2`).
 */
export interface NotificationDelivery {
  readonly recipientId: PrincipalId;
  readonly dedupeKey: DedupeKey;
  readonly requestId: RequestId;
  readonly eventType: WorkflowEventType;
  readonly outcomes: readonly ChannelOutcome[];
  readonly atMs: number;
}
