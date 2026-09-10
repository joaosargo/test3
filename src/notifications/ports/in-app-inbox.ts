/**
 * `InAppInboxPort` — the in-app notification channel + reader seam
 * (`domain-entities` `InAppInboxPort`, `business-rules` `BR-NOTIF-12`).
 *
 * `put` is the write half of the in-app channel (idempotent on
 * `(recipientId, dedupeKey)`); `list` / `markRead` are the self-scoped reader
 * side of `req-notifications-email-inapp`. The interface lives in the domain
 * ports layer; the in-memory adapter is the dev/test implementation, swappable
 * for a durable store in production — the same seam as `SessionStore` /
 * `RoleDirectoryPort` / `EventPublisher`.
 *
 * Self-scope (`BR-NOTIF-12`) is enforced by the `NotificationService`, not the
 * port: the port is a storage seam and takes the already-authorized recipient.
 */

import type { PrincipalId } from '../../domain/entities.js';
import type { Result } from '../../domain/result.js';
import type { InAppNotification } from '../domain/entities.js';
import type { NotificationId } from '../domain/value-objects.js';
import type { NotificationError } from '../domain/errors.js';

export interface InAppInboxPort {
  /**
   * Persist an in-app notification. Idempotent on `(recipientId, dedupeKey)`:
   * a repeat put for the same key is a no-op success (`BR-NOTIF-9`).
   */
  put(notification: InAppNotification): Promise<Result<void, NotificationError>>;

  /** Self-scoped read of a recipient's inbox, newest-first (`BR-NOTIF-12`). */
  list(recipientId: PrincipalId, unreadOnly?: boolean): Promise<readonly InAppNotification[]>;

  /** Load one notification by id (used for the self-scope guard on mark-read). */
  findById(id: NotificationId): Promise<InAppNotification | null>;

  /** Mark a notification read. Idempotent — already-read is a no-op success. */
  markRead(id: NotificationId): Promise<Result<void, NotificationError>>;
}
