/**
 * In-memory `ReminderLedgerRepository` adapter for unit-sla-escalation.
 *
 * Dev/test double. Enforces the APPEND-ONLY contract (`BR-SLA-7`): records are
 * pushed once and never mutated or deleted. Backs the idempotency guard
 * (`BR-SLA-6`) via `(requestId, stage, tier)` membership (`reminderKey`).
 * Production swaps a durable append-only store behind the same port, mirroring
 * the shipped `InMemoryNotificationDeliveryRepository` / `InMemorySessionStore`.
 *
 * PII (`BR-SLA-10 / BR-PII-4`): records carry only PII-free ids and outcome
 * codes; this double never logs them.
 */

import type { RequestId } from '../../workflow/domain/value-objects.js';
import type { ReminderLedgerRepository } from '../ports/reminder-ledger-repository.js';
import { reminderKey, type ReminderRecord } from '../domain/reminder-record.js';
import type { SlaStage, SlaTier } from '../domain/value-objects.js';

export class InMemoryReminderLedger implements ReminderLedgerRepository {
  private readonly records: ReminderRecord[] = [];
  private readonly keys = new Set<string>();

  async hasFired(requestId: RequestId, stage: SlaStage, tier: SlaTier): Promise<boolean> {
    return this.keys.has(reminderKey(requestId, stage, tier));
  }

  async record(record: ReminderRecord): Promise<void> {
    // Append-only: push a frozen snapshot; never rewrite a prior record.
    this.records.push({ ...record });
    this.keys.add(reminderKey(record.requestId, record.stage, record.tier));
  }

  /** Test accessor — the ordered append-only record list. */
  get all(): readonly ReminderRecord[] {
    return [...this.records];
  }
}
