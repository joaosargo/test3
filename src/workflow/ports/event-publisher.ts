/**
 * `EventPublisher` port — the choreography seam for unit-request-workflow
 * (business-logic-model Outbound domain events; domain-entities Domain Events).
 *
 * The workflow service publishes a past-tense `WorkflowEvent` per accepted
 * transition; side-effecting units (`audit-trail`, `notification`,
 * `overlap-indicator`) subscribe. This unit never calls those units directly —
 * it only publishes to this port, keeping the least-coupling boundary. The
 * in-process dev/test adapter records emitted events; production swaps a durable
 * bus (SNS/EventBridge, decided at infrastructure-design) behind the same port.
 */

import type { WorkflowEvent } from '../domain/events.js';

export interface EventPublisher {
  /**
   * Publish a domain event. Part of the same logical commit as the state change
   * so no transition is silently unaudited (`BR-INV-5`). Rejects only on
   * infrastructure failure (which the caller treats as a programmer/infra error).
   */
  publish(event: WorkflowEvent): Promise<void>;
}
