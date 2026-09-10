/**
 * `EmailSenderPort` — outbound email channel seam (`domain-entities`
 * `EmailSenderPort`, `business-rules` `BR-NOTIF-6/7/10`).
 *
 * Dispatches one email. Transient failures are retryable (`BR-NOTIF-10`); the
 * in-memory dev/test adapter records sent messages for assertions. Production
 * swaps a real provider (SES/SMTP) behind the same port — the same hexagonal
 * seam as `SessionStore` / `EventPublisher`. The channel is independent of the
 * in-app channel (`BR-NOTIF-7`), so its failure never aborts in-app delivery.
 */

import type { Result } from '../../domain/result.js';
import type { EmailMessage } from '../domain/value-objects.js';
import type { NotificationError } from '../domain/errors.js';

export interface EmailSenderPort {
  /**
   * Send one email. Returns `ok(void)` on accept; `err(CHANNEL_ERROR)` on a
   * transient failure the caller may retry / dead-letter (`BR-NOTIF-10`).
   */
  send(message: EmailMessage): Promise<Result<void, NotificationError>>;
}
