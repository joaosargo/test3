/**
 * `NotificationDeliveryRepository` — append-only operational record port
 * (`domain-entities` `NotificationDeliveryRepository`, `business-rules`
 * `BR-NOTIF-9/11`).
 *
 * `hasDelivery` is the idempotency guard consulted before a handling pass;
 * `record` appends one write-once `NotificationDelivery` per `(recipient,
 * event)` pass. Records are never mutated — this is the deterministic
 * idempotency + dead-letter reconciliation surface, distinct from the
 * compliance `audit-trail` owned by another unit.
 */

import type { PrincipalId } from '../../domain/entities.js';
import type { NotificationDelivery } from '../domain/entities.js';
import type { DedupeKey } from '../domain/value-objects.js';

export interface NotificationDeliveryRepository {
  /** True if a delivery already exists for `(recipientId, dedupeKey)` (`BR-NOTIF-9`). */
  hasDelivery(recipientId: PrincipalId, dedupeKey: DedupeKey): Promise<boolean>;

  /** Append a write-once delivery record (`BR-NOTIF-11`). */
  record(delivery: NotificationDelivery): Promise<void>;
}
