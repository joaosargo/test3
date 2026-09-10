/**
 * `ReminderRecord` — the append-only operational record for unit-sla-escalation
 * (functional-design `domain-entities` Entities & Aggregates).
 *
 * One record per fired `(requestId, stage, tier)`; the idempotency guard AND the
 * SLA-decision fact trail (`BR-SLA-6/7`). Write-once, never mutated — an
 * operational trail, distinct from both the compliance `audit-trail` (owned by
 * `unit-audit-trail`) and the notification unit's `NotificationDelivery`.
 *
 * PII (`BR-SLA-10 / BR-PII-4`): a record holds only `requestId`, `stage`,
 * `tier`, a PII-free `outcome` code, and `firedAtMs` — never contact details.
 *
 * Cross-unit references are ids (`RequestId`), not object graphs, matching the
 * least-coupling boundary the workflow/notification units established.
 */

import type { RequestId } from '../../workflow/domain/value-objects.js';
import type { SlaOutcomeCode, SlaStage, SlaTier } from './value-objects.js';

/** Append-only SLA-decision record. Identity is `(requestId, stage, tier)`. */
export interface ReminderRecord {
  /** The subject request (id ref, not object). */
  readonly requestId: RequestId;
  /** Which pending stage the notice was for (`BR-SLA-2`). */
  readonly stage: SlaStage;
  /** `Reminder` or `Escalation` (`OnTrack` is never recorded). */
  readonly tier: SlaTier;
  /** PII-free machine outcome (`BR-SLA-10 / BR-PII-4`). */
  readonly outcome: SlaOutcomeCode;
  /** Epoch ms the tier fired. */
  readonly firedAtMs: number;
}

/**
 * The composite idempotency key for a `(requestId, stage, tier)` triple
 * (`BR-SLA-6`). Used by the ledger's membership set. NUL-delimited to avoid
 * accidental collision between concatenated id segments.
 */
export function reminderKey(requestId: RequestId, stage: SlaStage, tier: SlaTier): string {
  return `${requestId}\u0000${stage}\u0000${tier}`;
}
