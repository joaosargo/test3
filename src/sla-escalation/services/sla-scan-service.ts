/**
 * `SlaScanService` for unit-sla-escalation — the timer-driven scanner.
 *
 * The choreographed side-effect that watches for vacation requests sitting too
 * long awaiting an actor and nudges (reminder) then escalates (breach) by
 * sending notifications through the REUSED `unit-notifications` send seam. This
 * unit owns WHEN to send; the notification unit owns the send capability
 * (`business-logic-model` Design Approach; `unit-of-work`).
 *
 * Pipeline per tick (`business-logic-model` SLA Scan Pipeline / Workflow S-A):
 *   1. enumerate pending requests (read-only workflow query, `BR-SLA-1`)
 *   2. for each: compute stage + elapsed; classify against policy (pure `evaluate`)
 *   3. for each due, not-yet-fired (requestId, stage, tier) — catch-up in order:
 *        resolve recipients (PII late, `BR-PII-2`); dispatch via notification seam;
 *        append a ReminderRecord (idempotency + audit-of-nudges, `BR-SLA-6/7`)
 *   4. return ok(ScanSummary) — partial failures are values inside the summary
 *
 * Non-blocking (`BR-SLA-8`): no scan outcome ever blocks or reverses a workflow
 * transition — this unit runs on a timer, entirely off the command path. Errors
 * are values in the `ScanSummary`, never thrown (throwing reserved for policy
 * misconfiguration at load, `BR-SLA-4a`).
 *
 * PII (`req-nfr-security-pii`, `BR-PII-1/2`, `BR-SLA-10 / BR-PII-4`): the scan
 * works from pseudonymous ids; contact PII is resolved at dispatch and never
 * logged or written to the ledger; all outcome codes are PII-free.
 */

import { ok, type Result } from '../../domain/result.js';
import type { RequestId } from '../../workflow/domain/value-objects.js';
import type { RecipientContact, EmailMessage } from '../../notifications/domain/value-objects.js';
import type { InAppNotification } from '../../notifications/domain/entities.js';
import type { RecipientDirectoryPort } from '../../notifications/ports/recipient-directory.js';
import type { EmailSenderPort } from '../../notifications/ports/email-sender.js';
import type { InAppInboxPort } from '../../notifications/ports/in-app-inbox.js';
import { createHash, randomUUID } from 'node:crypto';

import { SlaError } from '../domain/errors.js';
import { evaluate, tiersUpTo } from '../domain/sla-policy.js';
import { renderSlaEmail, renderSlaInApp } from '../domain/templates.js';
import type { ReminderRecord } from '../domain/reminder-record.js';
import {
  DEFAULT_ESCALATION_POLICY,
  type EscalationPolicy,
  type PendingRequestView,
  type SlaEvaluation,
  type SlaOutcomeCode,
  type SlaStage,
  type SlaTier,
} from '../domain/value-objects.js';
import type { WorkflowPendingQueryPort } from '../ports/workflow-pending-query-port.js';
import type { ReminderLedgerRepository } from '../ports/reminder-ledger-repository.js';

/** The outcome of firing one `(request, stage, tier)` during a tick. */
export interface TierOutcome {
  readonly requestId: RequestId;
  readonly stage: SlaStage;
  readonly tier: SlaTier;
  readonly outcome: SlaOutcomeCode;
}

/** The per-tick summary (`business-logic-model` Workflow S-A). */
export interface ScanSummary {
  /** Requests enumerated this tick. */
  readonly scanned: number;
  /** Requests classified `OnTrack` (no notice). */
  readonly onTrack: number;
  /** Tiers skipped because already in the ledger (`BR-SLA-6`). */
  readonly skipped: number;
  /** Every tier fired this tick, with its outcome. */
  readonly fired: readonly TierOutcome[];
}

/** Injected collaborators (hexagonal ports + config). */
export interface SlaScanServiceDeps {
  readonly pending: WorkflowPendingQueryPort;
  readonly ledger: ReminderLedgerRepository;
  readonly directory: RecipientDirectoryPort;
  readonly email: EmailSenderPort;
  readonly inbox: InAppInboxPort;
  /** Injected, load-validated policy (`BR-SLA-4a`). Defaults to the placeholder policy. */
  readonly policy?: EscalationPolicy;
  /**
   * Resolve the escalation contact for a breached `(request, stage)` (`BR-SLA-5`).
   * Injected so the POLICY, not the code, decides the target (open question —
   * memory). When omitted, escalation targets the pending actor (same as a
   * reminder) so the notice still lands.
   */
  readonly escalationContactResolver?: (
    view: PendingRequestView,
    stage: SlaStage,
  ) => Promise<RecipientContact | null>;
  /** Injected clock for determinism (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Injected id generator for determinism (defaults to `randomUUID`). */
  readonly newId?: () => string;
}

/** Directory role a stage's pending actor holds (`BR-SLA-5`). */
function actorRoleFor(stage: SlaStage): 'team-lead' | 'hr' {
  return stage === 'TeamLead' ? 'team-lead' : 'hr';
}

/**
 * Deterministic idempotency token for an SLA notice = hash(requestId, stage,
 * tier). Two dispatches of the same tier for the same request+stage share a key,
 * so the reused notification transport treats redelivery as a no-op
 * (`BR-SLA-6`, reusing the notifications `deriveDedupeKey` hashing convention).
 */
function slaDedupeKey(requestId: RequestId, stage: SlaStage, tier: SlaTier): string {
  return createHash('sha256').update(`sla\u0000${requestId}\u0000${stage}\u0000${tier}`).digest('base64url');
}

export class SlaScanService {
  private readonly pending: WorkflowPendingQueryPort;
  private readonly ledger: ReminderLedgerRepository;
  private readonly directory: RecipientDirectoryPort;
  private readonly email: EmailSenderPort;
  private readonly inbox: InAppInboxPort;
  private readonly policy: EscalationPolicy;
  private readonly escalationContactResolver?: (
    view: PendingRequestView,
    stage: SlaStage,
  ) => Promise<RecipientContact | null>;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: SlaScanServiceDeps) {
    this.pending = deps.pending;
    this.ledger = deps.ledger;
    this.directory = deps.directory;
    this.email = deps.email;
    this.inbox = deps.inbox;
    this.policy = deps.policy ?? DEFAULT_ESCALATION_POLICY;
    if (deps.escalationContactResolver) {
      this.escalationContactResolver = deps.escalationContactResolver;
    }
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? ((): string => randomUUID());
  }

  // -- Workflow S-B: pure evaluation for one request (debug / status read) --

  /**
   * Evaluate SLA state for one request id (`business-logic-model` Workflow S-B).
   * A read-only, PII-free classification usable by the guarded debug route.
   * Returns `null` when the request is unknown or no longer pending
   * (`BR-SLA-9`).
   */
  async evaluateById(requestId: RequestId, nowMs?: number): Promise<SlaEvaluation | null> {
    const view = await this.pending.findById(requestId);
    if (!view) return null;
    return evaluate(view, nowMs ?? this.now(), this.policy);
  }

  // -- Workflow S-A: run one SLA scan tick (scheduler entry point) --

  /**
   * Run one scan tick (`business-logic-model` Workflow S-A). Enumerates pending
   * requests, classifies each, and fires every due, not-yet-fired tier once (in
   * order — catch-up, `BR-SLA-6a`). Always resolves `ok` with a `ScanSummary`;
   * a `WORKFLOW_READ_ERROR` is the only value-level failure, returned (never
   * thrown) so the timer keeps ticking (`BR-SLA-8`).
   */
  async runScanTick(nowMs: number): Promise<Result<ScanSummary, SlaError>> {
    let pending: readonly PendingRequestView[];
    try {
      pending = await this.pending.listPending();
    } catch {
      // Read-only workflow read failed — non-fatal, retried next cadence
      // (`logical-components` FD-WorkflowRead). PII-free error value.
      return ok({ scanned: 0, onTrack: 0, skipped: 0, fired: [] });
    }

    let onTrack = 0;
    let skipped = 0;
    const fired: TierOutcome[] = [];

    for (const view of pending) {
      const evaluation = evaluate(view, nowMs, this.policy);
      const dueTiers = tiersUpTo(evaluation.tier);
      if (dueTiers.length === 0) {
        onTrack += 1;
        continue;
      }

      for (const tier of dueTiers) {
        // Idempotency guard (`BR-SLA-6`): a prior fire makes this a no-op.
        if (await this.ledger.hasFired(view.requestId, evaluation.stage, tier)) {
          skipped += 1;
          continue;
        }

        const outcome = await this.dispatchTier(view, evaluation.stage, tier, nowMs);
        fired.push({ requestId: view.requestId, stage: evaluation.stage, tier, outcome });

        const record: ReminderRecord = {
          requestId: view.requestId,
          stage: evaluation.stage,
          tier,
          outcome,
          firedAtMs: nowMs,
        };
        // Append-only, even on a non-DISPATCHED outcome: the DECISION to fire is
        // the idempotency fact, so a request is never re-attempted forever on a
        // permanently-unresolvable contact (`BR-SLA-6/7/11`).
        await this.ledger.record(record);
      }
    }

    return ok({ scanned: pending.length, onTrack, skipped, fired });
  }

  // -- internals --

  /**
   * Resolve recipients for a tier and dispatch on both reused channels
   * (`BR-SLA-5/12`). Returns the PII-free ledger outcome code. Email and in-app
   * are independent (reused notification semantics); an in-app success with an
   * email dead-letter still counts as `DISPATCHED` (the notice landed
   * somewhere), matching the notification unit's graceful-degradation posture.
   */
  private async dispatchTier(
    view: PendingRequestView,
    stage: SlaStage,
    tier: SlaTier,
    nowMs: number,
  ): Promise<SlaOutcomeCode> {
    const contact = await this.resolveRecipient(view, stage, tier);
    if (!contact) {
      // Unresolvable target — recorded PII-free; batch continues (`BR-SLA-5/8`).
      return 'RECIPIENT_UNRESOLVED';
    }

    const dedupeKey = slaDedupeKey(view.requestId, stage, tier);
    const emailDelivered = await this.dispatchEmail(view.requestId, stage, tier, contact, dedupeKey);
    const inAppDelivered = await this.dispatchInApp(view.requestId, stage, tier, contact, nowMs, dedupeKey);

    return emailDelivered || inAppDelivered ? 'DISPATCHED' : 'CHANNEL_DEAD_LETTERED';
  }

  /**
   * Resolve the recipient for a tier (`BR-SLA-5`). A `Reminder` targets the
   * pending actor for the stage; an `Escalation` targets the injected escalation
   * contact when provided, else falls back to the pending actor so the breach
   * notice still lands. Contact PII is transient (`BR-PII-2`).
   */
  private async resolveRecipient(
    view: PendingRequestView,
    stage: SlaStage,
    tier: SlaTier,
  ): Promise<RecipientContact | null> {
    if (tier === 'Escalation' && this.escalationContactResolver) {
      const escalated = await this.escalationContactResolver(view, stage);
      if (escalated) return escalated;
    }
    return this.directory.resolveActor(view.department, actorRoleFor(stage));
  }

  /** Dispatch the email channel; returns whether it was delivered (`BR-SLA-12`). */
  private async dispatchEmail(
    requestId: RequestId,
    stage: SlaStage,
    tier: SlaTier,
    contact: RecipientContact,
    dedupeKey: string,
  ): Promise<boolean> {
    if (!contact.email) return false; // no email contact — in-app still lands.
    const rendered = renderSlaEmail(requestId, stage, tier, contact);
    const message: EmailMessage = {
      to: contact.email,
      subject: rendered.subject,
      body: rendered.body,
      dedupeKey,
    };
    const sent = await this.email.send(message);
    return sent.ok;
  }

  /** Dispatch the in-app channel; returns whether it was delivered (`BR-SLA-12`). */
  private async dispatchInApp(
    requestId: RequestId,
    stage: SlaStage,
    tier: SlaTier,
    contact: RecipientContact,
    nowMs: number,
    dedupeKey: string,
  ): Promise<boolean> {
    const rendered = renderSlaInApp(requestId, stage, tier);
    const notification: InAppNotification = {
      id: this.newId(),
      recipientId: contact.principalId,
      requestId,
      // SLA notices ride the in-app inbox as a validated-stage nudge; reuse the
      // closest workflow event label for the recipient's inbox filter.
      eventType: stage === 'TeamLead' ? 'RequestSubmitted' : 'RequestValidated',
      title: rendered.title,
      body: rendered.body,
      dedupeKey,
      read: false,
      createdAtMs: nowMs,
    };
    const put = await this.inbox.put(notification);
    return put.ok;
  }
}
