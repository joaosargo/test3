/**
 * Value objects for unit-sla-escalation — the timer-driven SLA reminder and
 * escalation unit.
 *
 * Grounded in functional-design `domain-entities` (Value Objects) and
 * `business-rules` (`BR-SLA-4/4a/9`, `BR-SLA-10 / BR-PII-4`). All value objects
 * are immutable; equality is by attribute value (DDD value-object semantics),
 * consistent with the shipped `LeaveBalance` / `Session` / `DedupeKey` style.
 *
 * Identity, the workflow request model, and the notification transport are NOT
 * redefined here. This unit reuses read-only, by id (least coupling):
 *   - `PrincipalId` from unit-platform-auth (`src/domain/entities.ts`),
 *   - `RequestId`, `RequestStatus`, `WorkflowStage`, `DepartmentCode` from
 *     unit-request-workflow (`src/workflow/domain/value-objects.ts`).
 * It adds only the SLA-side value objects (policy, tier, evaluation, the
 * narrowed pending view) — concepts no other unit models.
 */

import type { PrincipalId } from '../../domain/entities.js';
import type {
  DepartmentCode,
  RequestId,
  RequestStatus,
  WorkflowStage,
} from '../../workflow/domain/value-objects.js';

/**
 * The pending stage a request is waiting in. Alias/reuse of the workflow
 * `WorkflowStage` (`TeamLead` | `HR`) so a stage means the same thing across
 * units (`domain-entities` `SlaStage`).
 */
export type SlaStage = WorkflowStage;

/**
 * Evaluation outcome tiers (`domain-entities` `SlaTier`, `business-rules`
 * `BR-SLA-4`). `evaluate` classifies a request into one of these; `OnTrack`
 * never fires.
 */
export const SLA_EVALUATION_TIERS = ['OnTrack', 'ReminderDue', 'EscalationDue'] as const;
export type SlaEvaluationTier = (typeof SLA_EVALUATION_TIERS)[number];

/**
 * The fired-tier tags recorded in the ledger. Ordered: `Reminder` precedes
 * `Escalation` (`BR-SLA-4`). `OnTrack` is never recorded.
 */
export const SLA_FIRED_TIERS = ['Reminder', 'Escalation'] as const;
export type SlaTier = (typeof SLA_FIRED_TIERS)[number];

/**
 * PII-free machine outcome for a fired tier (`BR-SLA-10 / BR-PII-4`). Never
 * carries an email, display name, or free-text reason.
 */
export const SLA_OUTCOME_CODES = ['DISPATCHED', 'RECIPIENT_UNRESOLVED', 'CHANNEL_DEAD_LETTERED'] as const;
export type SlaOutcomeCode = (typeof SLA_OUTCOME_CODES)[number];

/**
 * Per-stage config fragment (`domain-entities` `SlaThresholds`). Invariant:
 * `0 < reminderAfterMs < escalateAfterMs` (`BR-SLA-4/4a`), validated at load by
 * `validatePolicy`.
 */
export interface SlaThresholds {
  readonly reminderAfterMs: number;
  readonly escalateAfterMs: number;
}

/**
 * Injected SLA policy (`domain-entities` `EscalationPolicy`). A per-stage
 * threshold map plus the elapsed-time mode and the escalation-target selection.
 * Validated monotonic at load (`BR-SLA-4a`).
 *
 * `req-sla-reminder-escalation` fixes the behaviour but no numbers; thresholds
 * are configuration with documented placeholder defaults (see
 * `DEFAULT_ESCALATION_POLICY`), to be confirmed with product/HR
 * (functional-design open question).
 */
export interface EscalationPolicy {
  /** Per-stage thresholds. A stage absent from the map is treated `OnTrack`. */
  readonly thresholds: Partial<Record<SlaStage, SlaThresholds>>;
  /**
   * Elapsed-time mode (`BR-SLA-3`). `false`/omitted = wall-clock (MVP default);
   * `true` = business-hours-aware (deferred open question — see memory).
   */
  readonly businessHours?: boolean;
  /** Copy the request owner on a reminder for transparency (`BR-SLA-5`). */
  readonly copyOwnerOnReminder?: boolean;
}

/**
 * The narrowed, PII-free snapshot the scan consumes (`domain-entities`
 * `PendingRequestView`) — NOT the mutable `VacationRequest` aggregate. Produced
 * by the `WorkflowPendingQueryPort` (`BR-SLA-1`, boundary preserved).
 */
export interface PendingRequestView {
  readonly requestId: RequestId;
  readonly ownerId: PrincipalId;
  readonly department: DepartmentCode;
  /** Always non-terminal here (`Submitted` | `Validated`). */
  readonly status: RequestStatus;
  /** Epoch ms of the latest transition INTO `status` — the per-stage SLA clock (`BR-SLA-2`). */
  readonly enteredCurrentStatusAtMs: number;
}

/**
 * The pure result of `evaluate` (`domain-entities` `SlaEvaluation`). A computed
 * snapshot with no identity; equality by value.
 */
export interface SlaEvaluation {
  readonly requestId: RequestId;
  readonly stage: SlaStage;
  readonly elapsedMs: number;
  readonly tier: SlaEvaluationTier;
  /** The stage's config, echoed for transparency/debug. Absent if the stage has no policy. */
  readonly thresholds?: SlaThresholds;
}

/**
 * Placeholder default policy (`BR-SLA-4a`, illustrative only — confirm with
 * product/HR). Wall-clock elapsed; `TeamLead` reminder 24h / escalate 48h;
 * `HR` reminder 48h / escalate 96h.
 */
const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  thresholds: {
    TeamLead: { reminderAfterMs: 24 * HOUR_MS, escalateAfterMs: 48 * HOUR_MS },
    HR: { reminderAfterMs: 48 * HOUR_MS, escalateAfterMs: 96 * HOUR_MS },
  },
  businessHours: false,
  copyOwnerOnReminder: false,
};
