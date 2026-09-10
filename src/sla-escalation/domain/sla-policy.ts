/**
 * Pure SLA policy for unit-sla-escalation — the zero-I/O core
 * (`business-logic-model` Workflow S-B; `business-rules` `BR-SLA-2/3/4/4a/9`).
 *
 * Everything here is a PURE function: `validatePolicy`, `pendingStageOf`,
 * `elapsedMs`, `classify`, `evaluate`, and `tiersUpTo`. No I/O, so it is
 * exhaustively unit-testable — the same pure-core discipline as the workflow FSM
 * aggregate and the notification `recipientPolicy`. This is component C3 in
 * `logical-components` (p99 ≤ 1 ms, isolated from all I/O).
 *
 * The clock is passed as a value (`nowMs`, `enteredAtMs`) for deterministic
 * tests (`BR-SLA-3`, injected-clock discipline). Business-hours-awareness is a
 * policy flag whose full implementation is a deferred open question (memory);
 * the MVP default is wall-clock and the flag currently maps to wall-clock so the
 * seam exists without committing to a holiday calendar.
 */

import { isTerminal, type RequestStatus } from '../../workflow/domain/value-objects.js';
import { throwMisconfigured } from './errors.js';
import type {
  EscalationPolicy,
  PendingRequestView,
  SlaEvaluation,
  SlaEvaluationTier,
  SlaStage,
  SlaThresholds,
  SlaTier,
} from './value-objects.js';

/**
 * Map a non-terminal, awaiting-actor status to its pending stage (`BR-SLA-1`):
 * `Submitted` → awaiting `TeamLead`; `Validated` → awaiting `HR`. Returns
 * `null` for any status that is not awaiting an actor (terminal or unknown), so
 * the caller treats it as out-of-scope (`BR-SLA-9`).
 */
export function pendingStageOf(status: RequestStatus): SlaStage | null {
  switch (status) {
    case 'Submitted':
      return 'TeamLead';
    case 'Validated':
      return 'HR';
    default:
      return null;
  }
}

/**
 * Compute elapsed pending time (`BR-SLA-3`). Wall-clock by default; the
 * `businessHours` flag reserves the business-hours-aware seam (deferred open
 * question — currently wall-clock so the policy shape is stable). Never
 * negative — a future/clock-skewed `enteredAtMs` clamps to 0.
 */
export function elapsedMs(enteredAtMs: number, nowMs: number, _businessHours?: boolean): number {
  return Math.max(0, nowMs - enteredAtMs);
}

/**
 * Classify elapsed time against a stage's thresholds (`BR-SLA-4`). Returns the
 * HIGHEST tier whose threshold `elapsed` has crossed:
 * `OnTrack` → `ReminderDue` → `EscalationDue`. An absent threshold set means the
 * stage is uncovered → `OnTrack` (the policy, not the code, decides coverage).
 */
export function classify(elapsed: number, thresholds: SlaThresholds | undefined): SlaEvaluationTier {
  if (!thresholds) return 'OnTrack';
  if (elapsed >= thresholds.escalateAfterMs) return 'EscalationDue';
  if (elapsed >= thresholds.reminderAfterMs) return 'ReminderDue';
  return 'OnTrack';
}

/**
 * The ordered fired tiers up to and including the classified evaluation tier
 * (`BR-SLA-6a` catch-up). `ReminderDue` → `[Reminder]`; `EscalationDue` →
 * `[Reminder, Escalation]` (so a request first seen already past escalation
 * still gets its skipped reminder once); `OnTrack` → `[]`.
 */
export function tiersUpTo(tier: SlaEvaluationTier): readonly SlaTier[] {
  switch (tier) {
    case 'EscalationDue':
      return ['Reminder', 'Escalation'];
    case 'ReminderDue':
      return ['Reminder'];
    default:
      return [];
  }
}

/**
 * Evaluate SLA state for one pending request (`business-logic-model` Workflow
 * S-B). PURE — no I/O. A terminal/out-of-scope status classifies `OnTrack`
 * (`BR-SLA-9`); otherwise elapsed time is classified against the stage policy.
 */
export function evaluate(view: PendingRequestView, nowMs: number, policy: EscalationPolicy): SlaEvaluation {
  const stage = pendingStageOf(view.status);
  if (stage === null || isTerminal(view.status)) {
    // Not awaiting an actor — nothing pending (`BR-SLA-9`). Report the stage
    // best-effort; when there is none, fall back to `TeamLead` for the shape
    // (tier is `OnTrack`, so no notice ever fires from this branch).
    return {
      requestId: view.requestId,
      stage: stage ?? 'TeamLead',
      elapsedMs: 0,
      tier: 'OnTrack',
    };
  }

  const thresholds = policy.thresholds[stage];
  const elapsed = elapsedMs(view.enteredCurrentStatusAtMs, nowMs, policy.businessHours);
  const tier = classify(elapsed, thresholds);

  return {
    requestId: view.requestId,
    stage,
    elapsedMs: elapsed,
    tier,
    ...(thresholds !== undefined ? { thresholds } : {}),
  };
}

/**
 * Validate an injected policy at load — the ONE place a throw is allowed
 * (`BR-SLA-4a`, fail-closed). Every configured stage must have strictly
 * monotonic, positive thresholds (`0 < reminderAfterMs < escalateAfterMs`),
 * else `MISCONFIGURED_POLICY` is thrown so the unit never scans with a broken
 * policy. Returns the same policy for fluent composition. Messages are PII-free
 * (stage names only).
 */
export function validatePolicy(policy: EscalationPolicy): EscalationPolicy {
  const stages = Object.keys(policy.thresholds) as SlaStage[];
  if (stages.length === 0) {
    throwMisconfigured('no stage thresholds configured');
  }
  for (const stage of stages) {
    const t = policy.thresholds[stage];
    if (!t) continue;
    if (!(t.reminderAfterMs > 0)) {
      throwMisconfigured(`stage ${stage}: reminderAfterMs must be > 0`);
    }
    if (!(t.reminderAfterMs < t.escalateAfterMs)) {
      throwMisconfigured(`stage ${stage}: reminderAfterMs must be < escalateAfterMs`);
    }
  }
  return policy;
}
