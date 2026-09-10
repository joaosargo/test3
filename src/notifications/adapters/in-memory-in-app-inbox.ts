/**
 * In-memory `InAppInboxPort` adapter for unit-notifications.
 *
 * Dev/test double for the in-app channel + reader. Idempotent on
 * `(recipientId, dedupeKey)` (`BR-NOTIF-9`), lists a recipient's own inbox
 * newest-first (`BR-NOTIF-12`), and marks read idempotently. Production swaps a
 * durable store behind the same port, mirroring `in-memory-session-store.ts`.
 *
 * PII (`BR-PII-3`): a production store encrypts persisted bodies at rest; this
 * dev/test double holds them in memory and never logs them.
 */

import { ok, err, type Result } from '../../domain/result.js';
import type { PrincipalId } from '../../domain/entities.js';
import { NotificationError } from '../domain/errors.js';
import type { InAppInboxPort } from '../ports/in-app-inbox.js';
import type { InAppNotification } from '../domain/entities.js';
import type { NotificationId } from '../domain/value-objects.js';

export class InMemoryInAppInbox implements InAppInboxPort {
  private readonly byId = new Map<NotificationId, InAppNotification>();
  /** `(recipientId, dedupeKey)` → notificationId, for idempotent `put`. */
  private readonly byDedupe = new Map<string, NotificationId>();
  private failing = false;

  /** Put the inbox into a failing mode (exercise the dead-letter path). */
  setFailing(failing: boolean): this {
    this.failing = failing;
    return this;
  }

  async put(notification: InAppNotification): Promise<Result<void, NotificationError>> {
    if (this.failing) return err(NotificationError.channelError());
    const key = this.dedupeKey(notification.recipientId, notification.dedupeKey);
    // Idempotent: a repeat for the same (recipient, dedupeKey) is a no-op.
    if (this.byDedupe.has(key)) return ok(undefined);
    this.byId.set(notification.id, notification);
    this.byDedupe.set(key, notification.id);
    return ok(undefined);
  }

  async list(recipientId: PrincipalId, unreadOnly?: boolean): Promise<readonly InAppNotification[]> {
    return [...this.byId.values()]
      .filter((n) => n.recipientId === recipientId && (!unreadOnly || !n.read))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  async findById(id: NotificationId): Promise<InAppNotification | null> {
    return this.byId.get(id) ?? null;
  }

  async markRead(id: NotificationId): Promise<Result<void, NotificationError>> {
    const existing = this.byId.get(id);
    if (!existing) return err(NotificationError.notFound());
    // Idempotent — already-read is a no-op success.
    if (!existing.read) this.byId.set(id, { ...existing, read: true });
    return ok(undefined);
  }

  private dedupeKey(recipientId: PrincipalId, dedupeKey: string): string {
    return `${recipientId}\u0000${dedupeKey}`;
  }
}
