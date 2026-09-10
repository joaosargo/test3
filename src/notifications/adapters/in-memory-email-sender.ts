/**
 * In-memory `EmailSenderPort` adapter for unit-notifications.
 *
 * Dev/test double. Records sent messages so tests can assert the
 * notify-per-event behaviour, and can be put into a failing mode to exercise
 * the retry/dead-letter path (`BR-NOTIF-10`). Production swaps a real provider
 * (SES/SMTP) behind the same port. Mirrors the in-memory adapter pattern of the
 * shipped units (`InMemoryEventPublisher`).
 *
 * PII (`BR-PII-2`): the recorded messages carry PII (recipient email/body) for
 * test assertions only; this double never logs them.
 */

import { ok, err, type Result } from '../../domain/result.js';
import { NotificationError } from '../domain/errors.js';
import type { EmailSenderPort } from '../ports/email-sender.js';
import type { EmailMessage } from '../domain/value-objects.js';

export class InMemoryEmailSender implements EmailSenderPort {
  private readonly sentMessages: EmailMessage[] = [];
  private failing = false;

  /** Put the sender into a failing mode (exercise the dead-letter path). */
  setFailing(failing: boolean): this {
    this.failing = failing;
    return this;
  }

  async send(message: EmailMessage): Promise<Result<void, NotificationError>> {
    if (this.failing) return err(NotificationError.channelError());
    this.sentMessages.push(message);
    return ok(undefined);
  }

  /** Test accessor — the ordered list of accepted messages. */
  get sent(): readonly EmailMessage[] {
    return [...this.sentMessages];
  }
}
