/**
 * Public API for unit-notifications — the choreographed Notification unit.
 *
 * The composition root (app.ts / server.ts) imports this unit exclusively
 * through this surface, keeping the unit's internals encapsulated — mirroring
 * `src/authz/index.ts` and `src/workflow/index.ts`. The unit subscribes to the
 * shipped `EventPublisher` choreography seam (unit-request-workflow) and never
 * calls the workflow back.
 *
 * Grounded in `unit-of-work` (`unit-notifications — Notification`) and the
 * unit's functional-design artifacts (business-logic-model, domain-entities,
 * business-rules) and nfr-design (reliability-design).
 */

export { NotificationService } from './services/notification-service.js';
export type {
  NotificationServiceDeps,
  NotificationBatchResult,
  RecipientResult,
} from './services/notification-service.js';

export { buildNotificationRouter } from './http/notification-router.js';
export type { NotificationRouterDeps } from './http/notification-router.js';

export { NotificationError } from './domain/errors.js';
export type { NotificationErrorCode } from './domain/errors.js';

export {
  NOTIFICATION_CHANNELS,
  CHANNEL_STATUSES,
  deriveDedupeKey,
} from './domain/value-objects.js';
export type {
  NotificationId,
  NotificationChannel,
  ChannelStatus,
  ChannelOutcome,
  OutcomeReason,
  DedupeKey,
  RecipientContact,
  EmailMessage,
} from './domain/value-objects.js';

export type { InAppNotification, NotificationDelivery } from './domain/entities.js';

export { renderInApp, renderEmail } from './domain/templates.js';
export type { RenderedInApp, RenderedEmail } from './domain/templates.js';

export {
  recipientsFor,
  DEFAULT_RECIPIENT_POLICY,
} from './domain/recipient-policy.js';
export type {
  RecipientTarget,
  RecipientPolicyConfig,
  DirectoryRole,
} from './domain/recipient-policy.js';

export type { RecipientDirectoryPort } from './ports/recipient-directory.js';
export type { EmailSenderPort } from './ports/email-sender.js';
export type { InAppInboxPort } from './ports/in-app-inbox.js';
export type { NotificationDeliveryRepository } from './ports/notification-delivery-repository.js';

export { InMemoryRecipientDirectory } from './adapters/in-memory-recipient-directory.js';
export { InMemoryEmailSender } from './adapters/in-memory-email-sender.js';
export { InMemoryInAppInbox } from './adapters/in-memory-in-app-inbox.js';
export { InMemoryNotificationDeliveryRepository } from './adapters/in-memory-notification-delivery-repository.js';

export { registerNotificationSubscriber } from './subscribe.js';
