/**
 * SLA notice templates for unit-sla-escalation.
 *
 * Grounded in functional-design `business-logic-model` (render step) and
 * `business-rules` (`BR-PII-1/2`). Renders a channel-specific
 * subject/body/title for a reminder or escalation from the PII-FREE request id
 * plus (for email) the resolved contact display name. Single default locale for
 * MVP (localization deferred, mirroring the notifications unit).
 *
 * PII (`BR-PII-1` / `BR-PII-2`): the in-app title/body are built ONLY from the
 * PII-free `requestId`, `stage`, and `tier` — no email or free-text reason. The
 * email greeting may use a display name resolved at send time; it is never
 * logged. The SLA content is a NEW reason to notify (a request has waited too
 * long) — not a new transport (that is reused from `unit-notifications`).
 */

import type { RequestId } from '../../workflow/domain/value-objects.js';
import type { RecipientContact } from '../../notifications/domain/value-objects.js';
import type { SlaStage, SlaTier } from './value-objects.js';

/** A rendered in-app SLA copy (PII-minimal). */
export interface RenderedSlaInApp {
  readonly title: string;
  readonly body: string;
}

/** A rendered SLA email copy (subject + body). */
export interface RenderedSlaEmail {
  readonly subject: string;
  readonly body: string;
}

/** Short, PII-free reference to the request for user-facing copy (id only). */
function requestRef(requestId: RequestId): string {
  return `request ${requestId}`;
}

/** Which actor a stage is waiting on, for user-facing copy (PII-free label). */
function actorLabel(stage: SlaStage): string {
  return stage === 'TeamLead' ? 'team lead validation' : 'HR approval';
}

/** PII-free headline for a fired SLA tier at a stage (`BR-PII-1`). */
function headlineFor(stage: SlaStage, tier: SlaTier): string {
  const awaiting = actorLabel(stage);
  return tier === 'Escalation'
    ? `Vacation request breached SLA — still awaiting ${awaiting}`
    : `Reminder: vacation request awaiting ${awaiting}`;
}

/** Render the in-app SLA notice from PII-free fields only (`BR-PII-1`). */
export function renderSlaInApp(requestId: RequestId, stage: SlaStage, tier: SlaTier): RenderedSlaInApp {
  const title = headlineFor(stage, tier);
  return {
    title,
    body: `${title}. See ${requestRef(requestId)} for details.`,
  };
}

/**
 * Render the SLA email copy. The greeting uses the resolved display name when
 * present (PII, used transiently, never logged — `BR-PII-2`); the substantive
 * content is the same PII-free headline as the in-app copy.
 */
export function renderSlaEmail(
  requestId: RequestId,
  stage: SlaStage,
  tier: SlaTier,
  contact: RecipientContact,
): RenderedSlaEmail {
  const headline = headlineFor(stage, tier);
  const greeting = contact.displayName ? `Hello ${contact.displayName},` : 'Hello,';
  return {
    subject: headline,
    body: `${greeting}\n\n${headline}. See ${requestRef(requestId)} for details.\n`,
  };
}
