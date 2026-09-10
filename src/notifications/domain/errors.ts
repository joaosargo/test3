/**
 * Notification error taxonomy for unit-notifications.
 *
 * Grounded in functional-design `domain-entities` (`NotificationError`) and
 * `business-rules` (`BR-PII-4` PII-free codes). Expected value-level failures
 * (read/mark-read authorization, unknown notification) are returned as
 * `Result.err` values carrying a machine-readable, PII-free code — never
 * thrown. Throwing is reserved for programmer error / misconfiguration,
 * mirroring the shipped `SsoError` / `AuthzError` / `WorkflowError` taxonomy.
 *
 * PII rule (`req-nfr-security-pii`, `BR-PII-2`/`BR-PII-4`): codes and messages
 * MUST NOT contain the subject principal id, email, display name, or free-text
 * reason.
 */

/** Machine-readable notification failure codes (PII-free, `BR-PII-4`). */
export type NotificationErrorCode =
  | 'NOT_FOUND' // mark-read targets an unknown notification id
  | 'FORBIDDEN' // self-scope violation (`BR-NOTIF-12`)
  | 'RECIPIENT_UNRESOLVED' // directory could not resolve a recipient contact
  | 'CHANNEL_ERROR'; // a channel adapter failed (transient / dead-lettered)

/**
 * Typed notification error. Carries a machine-readable code and a PII-free
 * message; returned inside `Result<T, NotificationError>`. Mirrors the shipped
 * `WorkflowError` / `AuthzError` shape for a consistent boundary error across
 * the monolith.
 */
export class NotificationError extends Error {
  readonly code: NotificationErrorCode;

  constructor(code: NotificationErrorCode, message: string) {
    super(message);
    this.name = 'NotificationError';
    this.code = code;
    Object.setPrototypeOf(this, NotificationError.prototype);
  }

  static notFound(): NotificationError {
    return new NotificationError('NOT_FOUND', 'The requested resource was not found.');
  }

  static forbidden(): NotificationError {
    return new NotificationError('FORBIDDEN', 'You do not have permission to perform this action.');
  }

  static recipientUnresolved(): NotificationError {
    return new NotificationError('RECIPIENT_UNRESOLVED', 'The recipient could not be resolved.');
  }

  static channelError(): NotificationError {
    return new NotificationError('CHANNEL_ERROR', 'A notification channel failed to deliver.');
  }
}
