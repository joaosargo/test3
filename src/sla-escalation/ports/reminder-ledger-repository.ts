/**
 * `ReminderLedgerRepository` — the append-only ledger seam owned by
 * unit-sla-escalation (functional-design `domain-entities` Ports;
 * `business-rules` `BR-SLA-6/7`).
 *
 * The idempotency + SLA-decision-fact surface. Keyed by the composite
 * `(requestId, stage, tier)` (`reminderKey`), it exposes only `hasFired`
 * (single-key membership read, `BR-SLA-6`) and `record` (append, `BR-SLA-7`) —
 * there is NO update or delete at the contract level (append-only, like
 * `NotificationDeliveryRepository` / `AuditStore`).
 *
 * The in-memory adapter is the dev/test implementation, swappable for a durable
 * append-only store in production behind the same seam
 * (`tech-stack-decisions` Persistence).
 *
 * PII (`BR-SLA-10 / BR-PII-4`): records carry only PII-free ids and outcome
 * codes; this port never accepts or returns contact data.
 */

import type { RequestId } from '../../workflow/domain/value-objects.js';
import type { ReminderRecord } from '../domain/reminder-record.js';
import type { SlaStage, SlaTier } from '../domain/value-objects.js';

export interface ReminderLedgerRepository {
  /** Has this `(requestId, stage, tier)` already fired? The idempotency guard (`BR-SLA-6`). */
  hasFired(requestId: RequestId, stage: SlaStage, tier: SlaTier): Promise<boolean>;

  /** Append one record. Append-only (`BR-SLA-7`) — never updates or deletes. */
  record(record: ReminderRecord): Promise<void>;
}
