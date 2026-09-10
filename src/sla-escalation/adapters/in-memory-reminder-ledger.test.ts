import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryReminderLedger } from './in-memory-reminder-ledger.js';
import type { ReminderRecord } from '../domain/reminder-record.js';

/**
 * Unit tests for the append-only in-memory reminder ledger (`business-rules`
 * `BR-SLA-6/7`, `BR-SLA-10 / BR-PII-4`). Idempotency membership by
 * `(requestId, stage, tier)`; append-only, never mutated.
 */

function record(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    requestId: 'req-1',
    stage: 'TeamLead',
    tier: 'Reminder',
    outcome: 'DISPATCHED',
    firedAtMs: 1000,
    ...overrides,
  };
}

describe('InMemoryReminderLedger', () => {
  let ledger: InMemoryReminderLedger;

  beforeEach(() => {
    ledger = new InMemoryReminderLedger();
  });

  it('hasFired is false before any record (BR-SLA-6)', async () => {
    expect(await ledger.hasFired('req-1', 'TeamLead', 'Reminder')).toBe(false);
  });

  it('records then reports fired for the same (requestId, stage, tier)', async () => {
    await ledger.record(record());
    expect(await ledger.hasFired('req-1', 'TeamLead', 'Reminder')).toBe(true);
  });

  it('keys are independent per stage and per tier', async () => {
    await ledger.record(record({ tier: 'Reminder' }));
    expect(await ledger.hasFired('req-1', 'TeamLead', 'Escalation')).toBe(false);
    expect(await ledger.hasFired('req-1', 'HR', 'Reminder')).toBe(false);
  });

  it('is append-only — records accumulate and are never overwritten (BR-SLA-7)', async () => {
    await ledger.record(record({ tier: 'Reminder' }));
    await ledger.record(record({ tier: 'Escalation', firedAtMs: 2000 }));
    expect(ledger.all).toHaveLength(2);
    expect(ledger.all.map((r) => r.tier)).toEqual(['Reminder', 'Escalation']);
  });

  it('stores a frozen snapshot (external mutation of the source is not reflected)', async () => {
    const source = record();
    await ledger.record(source);
    expect(ledger.all[0]).toEqual(source);
    expect(ledger.all[0]).not.toBe(source);
  });
});
