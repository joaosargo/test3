/**
 * In-memory `NotificationDeliveryRepository` adapter for unit-notifications.
 *
 * Dev/test double. Enforces the APPEND-ONLY contract (`BR-NOTIF-11`): records
 * are pushed once and never mutated. Backs the idempotency guard (`BR-NOTIF-9`)
 * via `(recipientId, dedupeKey)` membership. Production swaps a durable
 * append-only store behind the same port, mirroring the shipped in-memory
 * adapters.
 *
 * PII (`BR-PII-2/4`): delivery records carry only PII-free ids and outcome
 * codes; this double never logs them.
 */

import type { PrincipalId } from '../../domain/entities.js';
import type { NotificationDeliveryRepository } from '../ports/notification-delivery-repository.js';
import type { NotificationDelivery } from '../domain/entities.js';
import type { DedupeKey } from '../domain/value-objects.js';

export class InMemoryNotificationDeliveryRepository implements NotificationDeliveryRepository {
  private readonly records: NotificationDelivery[] = [];
  private readonly keys = new Set<string>();

  async hasDelivery(recipientId: PrincipalId, dedupeKey: DedupeKey): Promise<boolean> {
    return this.keys.has(this.key(recipientId, dedupeKey));
  }

  async record(delivery: NotificationDelivery): Promise<void> {
    // Append-only: push a frozen snapshot; never rewrite prior records.
    this.records.push({ ...delivery, outcomes: [...delivery.outcomes] });
    this.keys.add(this.key(delivery.recipientId, delivery.dedupeKey));
  }

  /** Test accessor — the ordered append-only record list. */
  get all(): readonly NotificationDelivery[] {
    return [...this.records];
  }

  private key(recipientId: PrincipalId, dedupeKey: DedupeKey): string {
    return `${recipientId}\u0000${dedupeKey}`;
  }
}
