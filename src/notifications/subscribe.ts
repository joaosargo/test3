/**
 * Choreography wiring for unit-notifications.
 *
 * Registers the `NotificationService` as an in-process subscriber on the
 * shipped `InMemoryEventPublisher` (unit-request-workflow) — the inbound
 * choreography seam (`business-logic-model` Data Flow & Integration Points).
 * The workflow unit is unaware of this consumer (least coupling); production
 * swaps a durable-bus subscription behind the same shape.
 *
 * Non-blocking (`BR-NOTIF-8`): the handler never throws back at the publisher —
 * `handleEvent` always resolves `ok` with a batch result, so a notification
 * failure cannot reverse the source transition (which already committed).
 */

import type { InMemoryEventPublisher } from '../workflow/adapters/in-memory-event-publisher.js';
import type { NotificationService } from './services/notification-service.js';

/**
 * Subscribe `service.handleEvent` to every workflow event published on
 * `publisher`. Used by the composition root to wire the choreography in dev/test.
 */
export function registerNotificationSubscriber(
  publisher: InMemoryEventPublisher,
  service: NotificationService,
): void {
  publisher.subscribe(async (event) => {
    await service.handleEvent(event);
  });
}
