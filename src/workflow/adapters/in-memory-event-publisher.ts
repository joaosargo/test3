/**
 * In-memory `EventPublisher` adapter for unit-request-workflow.
 *
 * Dev/test double for the choreography bus. Records published events so tests
 * can assert the event-per-transition invariant (`BR-INV-5`) and so a local
 * composition can wire in-process subscribers. Production swaps a durable bus
 * behind the same port (infrastructure-design). Mirrors the in-memory adapter
 * pattern of the shipped units.
 */

import type { WorkflowEvent } from '../domain/events.js';
import type { EventPublisher } from '../ports/event-publisher.js';

/** A subscriber invoked for every published event (in-process choreography). */
export type WorkflowEventHandler = (event: WorkflowEvent) => void | Promise<void>;

export class InMemoryEventPublisher implements EventPublisher {
  private readonly published: WorkflowEvent[] = [];
  private readonly handlers: WorkflowEventHandler[] = [];

  /** Register an in-process subscriber (audit-trail / notification / overlap). */
  subscribe(handler: WorkflowEventHandler): void {
    this.handlers.push(handler);
  }

  async publish(event: WorkflowEvent): Promise<void> {
    this.published.push(event);
    for (const handler of this.handlers) {
      await handler(event);
    }
  }

  /** Test accessor — the ordered list of published events. */
  get events(): readonly WorkflowEvent[] {
    return [...this.published];
  }
}
