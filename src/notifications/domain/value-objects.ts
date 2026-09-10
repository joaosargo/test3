/**
 * Value objects for unit-notifications.
 *
 * Grounded in functional-design `domain-entities` (Value Objects) and
 * `business-rules` (`BR-NOTIF-*`, `BR-PII-*`) for this unit. All value objects
 * are immutable; equality is by attribute value (DDD value-object semantics),
 * consistent with the shipped `LeaveBalance` / `Session` / `DateRange` style.
 *
 * Identity, the workflow event contract, and authorization are NOT redefined
 * here — `PrincipalId` is reused read-only from unit-platform-auth
 * (`src/domain/entities.ts`), and the `WorkflowEvent` union / `RequestId` /
 * `WorkflowEventType` are reused read-only from unit-request-workflow
 * (`src/workflow/...`). Cross-unit references use ids, not object graphs
 * (least coupling), per `unit-of-work` (`unit-notifications — Notification`).
 */

import { createHash } from 'node:crypto';
import type { WorkflowEventType } from '../../workflow/domain/events.js';
import type { RequestId } from '../../workflow/domain/value-objects.js';

/** Opaque, unique identifier of an in-app notification (UUID string). */
export type NotificationId = string;

/** Delivery channels (`req-notifications-email-inapp` names both). */
export const NOTIFICATION_CHANNELS = ['Email', 'InApp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Per-channel delivery status (functional-design `domain-entities`). */
export const CHANNEL_STATUSES = ['Delivered', 'Skipped', 'DeadLettered'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/**
 * PII-free machine reason for a non-delivered outcome (`BR-PII-4`). Never
 * carries an email, display name, or free-text reason.
 */
export type OutcomeReason =
  | 'RECIPIENT_UNRESOLVED'
  | 'NO_EMAIL_CONTACT'
  | 'CHANNEL_TRANSIENT'
  | 'CHANNEL_DEAD_LETTERED';

/** Per-channel result of one handling pass for one recipient. */
export interface ChannelOutcome {
  readonly channel: NotificationChannel;
  readonly status: ChannelStatus;
  /** PII-free machine code; present for `Skipped` / `DeadLettered`. */
  readonly reason?: OutcomeReason;
}

/**
 * Deterministic idempotency token = `hash(requestId, eventType, atMs)`
 * (`BR-NOTIF-9`). Two deliveries of the same event to the same recipient share
 * a `DedupeKey`, so redelivery is a no-op.
 */
export type DedupeKey = string;

/** Compute the deterministic dedupe key for an event (`BR-NOTIF-9`). */
export function deriveDedupeKey(requestId: RequestId, eventType: WorkflowEventType, atMs: number): DedupeKey {
  return createHash('sha256').update(`${requestId}\u0000${eventType}\u0000${atMs}`).digest('base64url');
}

/**
 * Recipient contact — PII-bearing and transient (`BR-PII-2`). Resolved on
 * demand by `RecipientDirectoryPort`; used only to build an outbound message,
 * NEVER logged and never written to a delivery record.
 */
export interface RecipientContact {
  readonly principalId: string;
  /** Subject email — PII; used only to build the outbound email. */
  readonly email?: string;
  /** Display name — PII; same handling. */
  readonly displayName?: string;
}

/** The payload handed to `EmailSenderPort` (`domain-entities` `EmailMessage`). */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly dedupeKey: DedupeKey;
}
