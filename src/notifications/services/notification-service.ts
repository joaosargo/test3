/**
 * `NotificationService` for unit-notifications.
 *
 * The choreographed side-effect that turns each vacation-request state change
 * into an email + in-app notification for the people who need to know. This
 * unit is a pure EVENT CONSUMER: it subscribes to the shipped `WorkflowEvent`
 * contract via the `EventPublisher` choreography seam and never calls the
 * workflow back (least coupling, per `business-logic-model` and the
 * `unit-of-work` `unit-notifications — Notification` definition).
 *
 * Pipeline per consumed event (business-logic-model Notification Pipeline):
 *   1. resolve recipients            (recipient-policy, `BR-NOTIF-1..5`)
 *   2. idempotency guard per recipient (`dedupeKey`, `BR-NOTIF-9`)
 *   3. resolve contact               (`RecipientDirectoryPort`, PII late `BR-PII-2`)
 *   4. render + dispatch per channel (independent, `BR-NOTIF-6/7`)
 *   5. record append-only delivery   (`BR-NOTIF-11`)
 *
 * Non-blocking (`BR-NOTIF-8`): a notification failure is captured inside the
 * batch result — never thrown back at the workflow, which already committed
 * (workflow `BR-INV-5`). Errors are returned via the shared `Result<T, E>`
 * convention (`src/domain/result.ts`); throwing is reserved for
 * misconfiguration.
 *
 * PII (`req-nfr-security-pii`, `BR-PII-1/2/4`): the event bus stays PII-free;
 * contact PII is resolved at send time and never logged or written to a
 * delivery record; all outcome/error codes are PII-free.
 */

import { randomUUID } from 'node:crypto';
import { ok, err, type Result } from '../../domain/result.js';
import type { PrincipalId, AuthenticatedPrincipal } from '../../domain/entities.js';
import type { WorkflowEvent } from '../../workflow/domain/events.js';
import type { InAppNotification, NotificationDelivery } from '../domain/entities.js';
import { NotificationError } from '../domain/errors.js';
import {
  deriveDedupeKey,
  type ChannelOutcome,
  type EmailMessage,
  type NotificationId,
  type RecipientContact,
} from '../domain/value-objects.js';
import { renderEmail, renderInApp } from '../domain/templates.js';
import {
  recipientsFor,
  DEFAULT_RECIPIENT_POLICY,
  type RecipientPolicyConfig,
  type RecipientTarget,
} from '../domain/recipient-policy.js';
import type { RecipientDirectoryPort } from '../ports/recipient-directory.js';
import type { EmailSenderPort } from '../ports/email-sender.js';
import type { InAppInboxPort } from '../ports/in-app-inbox.js';
import type { NotificationDeliveryRepository } from '../ports/notification-delivery-repository.js';

/** Per-recipient result within a handling pass. */
export interface RecipientResult {
  readonly recipientId: PrincipalId;
  readonly outcomes: readonly ChannelOutcome[];
}

/** The result of handling one consumed event (`handleEvent`). */
export interface NotificationBatchResult {
  readonly eventType: WorkflowEvent['type'];
  readonly requestId: string;
  readonly results: readonly RecipientResult[];
}

/** Injected collaborators (hexagonal ports + config). */
export interface NotificationServiceDeps {
  readonly directory: RecipientDirectoryPort;
  readonly email: EmailSenderPort;
  readonly inbox: InAppInboxPort;
  readonly deliveries: NotificationDeliveryRepository;
  /** Optional recipient-copy policy (`BR-NOTIF-5`). Defaults keep copies off. */
  readonly recipientPolicy?: RecipientPolicyConfig;
  /** Injected clock for determinism (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Injected id generator for determinism (defaults to `randomUUID`). */
  readonly newId?: () => NotificationId;
}

export class NotificationService {
  private readonly directory: RecipientDirectoryPort;
  private readonly email: EmailSenderPort;
  private readonly inbox: InAppInboxPort;
  private readonly deliveries: NotificationDeliveryRepository;
  private readonly recipientPolicy: RecipientPolicyConfig;
  private readonly now: () => number;
  private readonly newId: () => NotificationId;

  constructor(deps: NotificationServiceDeps) {
    this.directory = deps.directory;
    this.email = deps.email;
    this.inbox = deps.inbox;
    this.deliveries = deps.deliveries;
    this.recipientPolicy = deps.recipientPolicy ?? DEFAULT_RECIPIENT_POLICY;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? ((): NotificationId => randomUUID());
  }

  // -- Workflow N-A: handle a state-change event (subscriber entry point) --

  /**
   * Consume one workflow event and fan out to every recipient / channel
   * (`business-logic-model` Workflow N-A). Always resolves `ok` with a batch
   * result — partial failures are inside the result, never thrown
   * (`BR-NOTIF-8`).
   */
  async handleEvent(event: WorkflowEvent): Promise<Result<NotificationBatchResult, NotificationError>> {
    const targets = recipientsFor(event, this.recipientPolicy);
    const dedupeKey = deriveDedupeKey(event.requestId, event.type, event.atMs);
    const results: RecipientResult[] = [];

    for (const target of targets) {
      const contact = await this.resolveTarget(target);

      if (!contact) {
        // Unresolvable recipient — record skipped, never fail the batch
        // (`BR-NOTIF-4/8`). Required-but-missing is still non-fatal here.
        const outcomes: ChannelOutcome[] = [
          { channel: 'Email', status: 'Skipped', reason: 'RECIPIENT_UNRESOLVED' },
          { channel: 'InApp', status: 'Skipped', reason: 'RECIPIENT_UNRESOLVED' },
        ];
        results.push({ recipientId: this.targetId(target), outcomes });
        continue;
      }

      // Idempotency guard (`BR-NOTIF-9`): a prior pass for this
      // (recipient, dedupeKey) makes redelivery a no-op.
      if (await this.deliveries.hasDelivery(contact.principalId, dedupeKey)) {
        continue;
      }

      const outcomes = await this.dispatch(event, contact, dedupeKey);
      results.push({ recipientId: contact.principalId, outcomes });

      const delivery: NotificationDelivery = {
        recipientId: contact.principalId,
        dedupeKey,
        requestId: event.requestId,
        eventType: event.type,
        outcomes,
        atMs: this.now(),
      };
      await this.deliveries.record(delivery);
    }

    return ok({ eventType: event.type, requestId: event.requestId, results });
  }

  // -- Workflow N-B: read the in-app inbox (self-scoped) --

  /**
   * List the viewer's OWN in-app notifications (`business-logic-model` Workflow
   * N-B; `BR-NOTIF-12`). A principal may read only their own inbox — the port
   * is queried by the viewer's own id, so no cross-principal read is possible.
   */
  async listForRecipient(
    principal: AuthenticatedPrincipal,
    unreadOnly?: boolean,
  ): Promise<Result<readonly InAppNotification[], NotificationError>> {
    const list = await this.inbox.list(principal.principalId, unreadOnly);
    return ok(list);
  }

  /**
   * Mark one of the viewer's OWN notifications read (`BR-NOTIF-12`). Fail-closed
   * self-scope: unknown id → `NOT_FOUND`; another principal's notification →
   * `FORBIDDEN`. Idempotent — already-read is a no-op success.
   */
  async markRead(
    principal: AuthenticatedPrincipal,
    notificationId: NotificationId,
  ): Promise<Result<void, NotificationError>> {
    const existing = await this.inbox.findById(notificationId);
    if (!existing) return err(NotificationError.notFound());
    if (existing.recipientId !== principal.principalId) return err(NotificationError.forbidden());
    return this.inbox.markRead(notificationId);
  }

  // -- internals --

  /** Resolve a recipient target to a contact (principal or role-in-department). */
  private async resolveTarget(target: RecipientTarget): Promise<RecipientContact | null> {
    return target.kind === 'principal'
      ? this.directory.resolve(target.principalId)
      : this.directory.resolveActor(target.department, target.role);
  }

  /** Best-effort id for a target that could not be resolved (for the record). */
  private targetId(target: RecipientTarget): PrincipalId {
    return target.kind === 'principal' ? target.principalId : `${target.role}@${target.department}`;
  }

  /**
   * Dispatch both channels independently (`BR-NOTIF-6/7`). Email and in-app
   * outcomes are recorded separately; a failure on one channel never aborts the
   * other. A recipient with no email still receives the in-app copy.
   */
  private async dispatch(
    event: WorkflowEvent,
    contact: RecipientContact,
    dedupeKey: string,
  ): Promise<ChannelOutcome[]> {
    const emailOutcome = await this.dispatchEmail(event, contact, dedupeKey);
    const inAppOutcome = await this.dispatchInApp(event, contact, dedupeKey);
    return [emailOutcome, inAppOutcome];
  }

  private async dispatchEmail(
    event: WorkflowEvent,
    contact: RecipientContact,
    dedupeKey: string,
  ): Promise<ChannelOutcome> {
    if (!contact.email) {
      // Graceful degradation (`BR-NOTIF-6`): no email contact → skip email,
      // in-app still lands.
      return { channel: 'Email', status: 'Skipped', reason: 'NO_EMAIL_CONTACT' };
    }
    const rendered = renderEmail(event, contact);
    const message: EmailMessage = {
      to: contact.email,
      subject: rendered.subject,
      body: rendered.body,
      dedupeKey,
    };
    const sent = await this.email.send(message);
    return sent.ok
      ? { channel: 'Email', status: 'Delivered' }
      : { channel: 'Email', status: 'DeadLettered', reason: 'CHANNEL_DEAD_LETTERED' };
  }

  private async dispatchInApp(
    event: WorkflowEvent,
    contact: RecipientContact,
    dedupeKey: string,
  ): Promise<ChannelOutcome> {
    const rendered = renderInApp(event);
    const notification: InAppNotification = {
      id: this.newId(),
      recipientId: contact.principalId,
      requestId: event.requestId,
      eventType: event.type,
      title: rendered.title,
      body: rendered.body,
      dedupeKey,
      read: false,
      createdAtMs: this.now(),
    };
    const put = await this.inbox.put(notification);
    return put.ok
      ? { channel: 'InApp', status: 'Delivered' }
      : { channel: 'InApp', status: 'DeadLettered', reason: 'CHANNEL_DEAD_LETTERED' };
  }
}
