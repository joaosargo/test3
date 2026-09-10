/**
 * Notification templates for unit-notifications.
 *
 * Grounded in functional-design `domain-entities` (`NotificationTemplate`) and
 * `business-logic-model` (render step). Renders a channel-specific
 * subject/body/title from the PII-FREE event fields plus (for email) the
 * resolved contact display name. Single default locale for MVP (localization
 * deferred — see the unit's functional-design open question).
 *
 * PII (`BR-PII-1`/`BR-PII-2`): the in-app title/body are built ONLY from the
 * PII-free event (status, stage, request id) — no email or free-text reason.
 * The email body may greet with a display name resolved at send time; it is
 * never logged.
 */

import type { WorkflowEvent } from '../../workflow/domain/events.js';
import type { RecipientContact } from './value-objects.js';

/** A rendered in-app copy (PII-minimal). */
export interface RenderedInApp {
  readonly title: string;
  readonly body: string;
}

/** A rendered email copy (subject + body). */
export interface RenderedEmail {
  readonly subject: string;
  readonly body: string;
}

/** Short reference to the request for user-facing copy (id only — PII-free). */
function requestRef(event: WorkflowEvent): string {
  return `request ${event.requestId}`;
}

/** Human-readable, PII-free headline for each event type (`BR-NOTIF-1`). */
function headlineFor(event: WorkflowEvent): string {
  switch (event.type) {
    case 'RequestSubmitted':
      return 'Vacation request submitted';
    case 'RequestValidated':
      return 'Vacation request validated — awaiting HR approval';
    case 'RequestApproved':
      return 'Vacation request approved';
    case 'RequestRejected':
      return `Vacation request rejected at ${event.rejectedStage} stage`;
    case 'RequestWithdrawn':
      return 'Vacation request withdrawn';
    default:
      return 'Vacation request updated';
  }
}

/** Render the in-app notification copy from the PII-free event (`BR-PII-1`). */
export function renderInApp(event: WorkflowEvent): RenderedInApp {
  const title = headlineFor(event);
  return {
    title,
    body: `${title}. See ${requestRef(event)} for details.`,
  };
}

/**
 * Render the email copy. The greeting uses the resolved display name when
 * present (PII, used transiently, never logged — `BR-PII-2`); the substantive
 * content is the same PII-free headline as the in-app copy.
 */
export function renderEmail(event: WorkflowEvent, contact: RecipientContact): RenderedEmail {
  const headline = headlineFor(event);
  const greeting = contact.displayName ? `Hello ${contact.displayName},` : 'Hello,';
  return {
    subject: headline,
    body: `${greeting}\n\n${headline}. See ${requestRef(event)} for details.\n`,
  };
}
