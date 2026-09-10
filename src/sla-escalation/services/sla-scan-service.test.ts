import { describe, it, expect, beforeEach } from 'vitest';
import { SlaScanService } from './sla-scan-service.js';
import { InMemoryReminderLedger } from '../adapters/in-memory-reminder-ledger.js';
import { InMemoryRecipientDirectory } from '../../notifications/adapters/in-memory-recipient-directory.js';
import { InMemoryEmailSender } from '../../notifications/adapters/in-memory-email-sender.js';
import { InMemoryInAppInbox } from '../../notifications/adapters/in-memory-in-app-inbox.js';
import type { WorkflowPendingQueryPort } from '../ports/workflow-pending-query-port.js';
import type { EscalationPolicy, PendingRequestView } from '../domain/value-objects.js';
import type { RequestId } from '../../workflow/domain/value-objects.js';

/**
 * Unit tests for `SlaScanService.runScanTick` (`business-logic-model` Workflow
 * S-A; `business-rules` `BR-SLA-1/5/6/6a/8/9/11/12`, `BR-PII-*`). Uses the
 * in-memory port doubles; clock and id generator are injected for determinism.
 */

const HOUR = 60 * 60 * 1000;
const DEPT = 'engineering';

const policy: EscalationPolicy = {
  thresholds: {
    TeamLead: { reminderAfterMs: 24 * HOUR, escalateAfterMs: 48 * HOUR },
    HR: { reminderAfterMs: 48 * HOUR, escalateAfterMs: 96 * HOUR },
  },
};

/** A stub `WorkflowPendingQueryPort` driven by an in-memory list. */
class StubPendingQuery implements WorkflowPendingQueryPort {
  private views: PendingRequestView[] = [];
  fail = false;

  set(views: PendingRequestView[]): void {
    this.views = views;
  }

  async listPending(): Promise<readonly PendingRequestView[]> {
    if (this.fail) throw new Error('workflow read outage');
    return this.views;
  }

  async findById(requestId: RequestId): Promise<PendingRequestView | null> {
    return this.views.find((v) => v.requestId === requestId) ?? null;
  }
}

function view(overrides: Partial<PendingRequestView> = {}): PendingRequestView {
  return {
    requestId: 'req-1',
    ownerId: 'emp-1',
    department: DEPT,
    status: 'Submitted',
    enteredCurrentStatusAtMs: 0,
    ...overrides,
  };
}

interface Harness {
  service: SlaScanService;
  pending: StubPendingQuery;
  ledger: InMemoryReminderLedger;
  email: InMemoryEmailSender;
  inbox: InMemoryInAppInbox;
  directory: InMemoryRecipientDirectory;
}

function harness(): Harness {
  const pending = new StubPendingQuery();
  const ledger = new InMemoryReminderLedger();
  const email = new InMemoryEmailSender();
  const inbox = new InMemoryInAppInbox();
  const directory = new InMemoryRecipientDirectory()
    .addContact({ principalId: 'lead-1', email: 'lead@corp.example', displayName: 'Liam' })
    .addContact({ principalId: 'hr-1', email: 'hr@corp.example', displayName: 'Hannah' })
    .assignActor(DEPT, 'team-lead', 'lead-1')
    .assignActor(DEPT, 'hr', 'hr-1');
  let ids = 0;
  const service = new SlaScanService({
    pending,
    ledger,
    directory,
    email,
    inbox,
    policy,
    now: () => 0,
    newId: () => `notif-${++ids}`,
  });
  return { service, pending, ledger, email, inbox, directory };
}

describe('SlaScanService.runScanTick', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('is OnTrack (no notice) below the reminder threshold', async () => {
    h.pending.set([view({ enteredCurrentStatusAtMs: 0 })]);
    const result = await h.service.runScanTick(23 * HOUR);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.onTrack).toBe(1);
      expect(result.value.fired).toHaveLength(0);
    }
    expect(h.ledger.all).toHaveLength(0);
  });

  it('fires a reminder to the team lead once past the reminder threshold (BR-SLA-5)', async () => {
    h.pending.set([view({ enteredCurrentStatusAtMs: 0 })]);
    const result = await h.service.runScanTick(25 * HOUR);
    expect(result.ok && result.value.fired).toEqual([
      { requestId: 'req-1', stage: 'TeamLead', tier: 'Reminder', outcome: 'DISPATCHED' },
    ]);
    expect(h.email.sent).toHaveLength(1);
    expect(h.email.sent[0]!.to).toBe('lead@corp.example');
    expect((await h.inbox.list('lead-1'))).toHaveLength(1);
  });

  it('is idempotent — a second tick does not re-fire the same tier (BR-SLA-6)', async () => {
    h.pending.set([view({ enteredCurrentStatusAtMs: 0 })]);
    await h.service.runScanTick(25 * HOUR);
    const second = await h.service.runScanTick(26 * HOUR);
    expect(second.ok && second.value.fired).toHaveLength(0);
    expect(second.ok && second.value.skipped).toBe(1);
    expect(h.email.sent).toHaveLength(1); // still only the first send
    expect(h.ledger.all).toHaveLength(1);
  });

  it('catch-up fires both reminder and escalation when first seen past breach (BR-SLA-6a/11)', async () => {
    h.pending.set([view({ enteredCurrentStatusAtMs: 0 })]);
    const result = await h.service.runScanTick(50 * HOUR); // past 48h escalation
    expect(result.ok && result.value.fired.map((f) => f.tier)).toEqual(['Reminder', 'Escalation']);
    // Both tiers recorded independently in the ledger (BR-SLA-11).
    expect(h.ledger.all.map((r) => r.tier)).toEqual(['Reminder', 'Escalation']);
  });

  it('uses the HR clock and role for a validated request', async () => {
    h.pending.set([view({ status: 'Validated', enteredCurrentStatusAtMs: 0 })]);
    await h.service.runScanTick(50 * HOUR); // past HR reminder (48h), not escalate (96h)
    expect(h.email.sent[0]!.to).toBe('hr@corp.example');
    expect(h.ledger.all[0]!.stage).toBe('HR');
    expect(h.ledger.all[0]!.tier).toBe('Reminder');
  });

  it('records RECIPIENT_UNRESOLVED and continues when the actor is unresolvable (BR-SLA-5/8)', async () => {
    h.pending.set([view({ department: 'unknown-dept', enteredCurrentStatusAtMs: 0 })]);
    const result = await h.service.runScanTick(25 * HOUR);
    expect(result.ok).toBe(true);
    expect(h.ledger.all[0]!.outcome).toBe('RECIPIENT_UNRESOLVED');
    expect(h.email.sent).toHaveLength(0);
  });

  it('self-heals on a terminal request — no notice fires (BR-SLA-9)', async () => {
    h.pending.set([view({ status: 'Approved', enteredCurrentStatusAtMs: 0 })]);
    const result = await h.service.runScanTick(1000 * HOUR);
    expect(result.ok && result.value.onTrack).toBe(1);
    expect(h.ledger.all).toHaveLength(0);
  });

  it('routes an escalation to the injected escalation contact (BR-SLA-5)', async () => {
    h.directory.addContact({ principalId: 'ops-1', email: 'ops@corp.example' });
    const service = new SlaScanService({
      pending: h.pending,
      ledger: h.ledger,
      directory: h.directory,
      email: h.email,
      inbox: h.inbox,
      policy,
      escalationContactResolver: async () => ({ principalId: 'ops-1', email: 'ops@corp.example' }),
      now: () => 0,
      newId: () => 'notif-x',
    });
    h.pending.set([view({ enteredCurrentStatusAtMs: 0 })]);
    await service.runScanTick(50 * HOUR);
    const escalationEmail = h.email.sent.find((m) => m.subject.includes('breached SLA'));
    expect(escalationEmail!.to).toBe('ops@corp.example');
  });

  it('is non-blocking on a workflow read outage — returns ok with an empty summary (BR-SLA-8)', async () => {
    h.pending.fail = true;
    const result = await h.service.runScanTick(25 * HOUR);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.scanned).toBe(0);
  });

  it('still records DISPATCHED when email dead-letters but in-app lands (BR-SLA-12)', async () => {
    h.email.setFailing(true);
    h.pending.set([view({ enteredCurrentStatusAtMs: 0 })]);
    await h.service.runScanTick(25 * HOUR);
    expect(h.ledger.all[0]!.outcome).toBe('DISPATCHED');
    expect((await h.inbox.list('lead-1'))).toHaveLength(1);
  });

  it('records CHANNEL_DEAD_LETTERED when both channels fail (BR-SLA-12)', async () => {
    h.email.setFailing(true);
    h.inbox.setFailing(true);
    h.pending.set([view({ enteredCurrentStatusAtMs: 0 })]);
    await h.service.runScanTick(25 * HOUR);
    expect(h.ledger.all[0]!.outcome).toBe('CHANNEL_DEAD_LETTERED');
  });
});

describe('SlaScanService.evaluateById (Workflow S-B)', () => {
  it('returns a PII-free evaluation for a known pending request', async () => {
    const h = harness();
    h.pending.set([view({ enteredCurrentStatusAtMs: 0 })]);
    const evaluation = await h.service.evaluateById('req-1', 25 * HOUR);
    expect(evaluation!.tier).toBe('ReminderDue');
    expect(evaluation!.stage).toBe('TeamLead');
  });

  it('returns null for an unknown / non-pending request (BR-SLA-9)', async () => {
    const h = harness();
    h.pending.set([]);
    expect(await h.service.evaluateById('nope')).toBeNull();
  });
});
