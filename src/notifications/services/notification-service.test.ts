import { describe, it, expect, beforeEach } from 'vitest';
import { NotificationService } from './notification-service.js';
import { InMemoryRecipientDirectory } from '../adapters/in-memory-recipient-directory.js';
import { InMemoryEmailSender } from '../adapters/in-memory-email-sender.js';
import { InMemoryInAppInbox } from '../adapters/in-memory-in-app-inbox.js';
import { InMemoryNotificationDeliveryRepository } from '../adapters/in-memory-notification-delivery-repository.js';
import type { AuthenticatedPrincipal } from '../../domain/entities.js';
import type {
  RequestSubmitted,
  RequestApproved,
  RequestRejected,
} from '../../workflow/domain/events.js';

/**
 * Unit tests for `NotificationService` — the choreographed event handler and
 * self-scoped inbox reader (business-logic-model Workflows N-A / N-B;
 * business-rules `BR-NOTIF-*`, `BR-PII-*`). Uses the in-memory port doubles;
 * clock and id generator are injected for determinism.
 */

const DEPT = 'engineering';

function submitted(overrides: Partial<RequestSubmitted> = {}): RequestSubmitted {
  return {
    type: 'RequestSubmitted',
    requestId: 'req-1',
    ownerId: 'emp-1',
    department: DEPT,
    actorId: 'emp-1',
    status: 'Submitted',
    atMs: 1000,
    ...overrides,
  };
}

function approved(): RequestApproved {
  return {
    type: 'RequestApproved',
    requestId: 'req-1',
    ownerId: 'emp-1',
    department: DEPT,
    actorId: 'hr-1',
    status: 'Approved',
    atMs: 2000,
  };
}

function rejected(): RequestRejected {
  return {
    type: 'RequestRejected',
    requestId: 'req-1',
    ownerId: 'emp-1',
    department: DEPT,
    actorId: 'lead-1',
    status: 'Rejected',
    rejectedStage: 'TeamLead',
    atMs: 3000,
  };
}

const viewer: AuthenticatedPrincipal = { principalId: 'emp-1', rawClaims: {} };

describe('NotificationService — handleEvent (Workflow N-A)', () => {
  let directory: InMemoryRecipientDirectory;
  let email: InMemoryEmailSender;
  let inbox: InMemoryInAppInbox;
  let deliveries: InMemoryNotificationDeliveryRepository;
  let service: NotificationService;
  let ids: number;

  beforeEach(() => {
    directory = new InMemoryRecipientDirectory()
      .addContact({ principalId: 'emp-1', email: 'emp1@corp.example', displayName: 'Emma' })
      .addContact({ principalId: 'lead-1', email: 'lead1@corp.example', displayName: 'Liam' })
      .addContact({ principalId: 'hr-1', email: 'hr1@corp.example', displayName: 'Hannah' })
      .assignActor(DEPT, 'team-lead', 'lead-1')
      .assignActor(DEPT, 'hr', 'hr-1');
    email = new InMemoryEmailSender();
    inbox = new InMemoryInAppInbox();
    deliveries = new InMemoryNotificationDeliveryRepository();
    ids = 0;
    service = new NotificationService({
      directory,
      email,
      inbox,
      deliveries,
      now: () => 5000,
      newId: () => `notif-${++ids}`,
    });
  });

  it('notifies owner + team lead on RequestSubmitted, both channels each (BR-NOTIF-2/3/6)', async () => {
    const res = await service.handleEvent(submitted());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const notifiedIds = res.value.results.map((r) => r.recipientId).sort();
    expect(notifiedIds).toEqual(['emp-1', 'lead-1']);
    // Each recipient has an email + in-app outcome, both delivered.
    for (const r of res.value.results) {
      expect(r.outcomes.map((o) => o.channel).sort()).toEqual(['Email', 'InApp']);
      expect(r.outcomes.every((o) => o.status === 'Delivered')).toBe(true);
    }
    expect(email.sent).toHaveLength(2);
    expect(await inbox.list('emp-1')).toHaveLength(1);
    expect(await inbox.list('lead-1')).toHaveLength(1);
  });

  it('notifies only the owner on a terminal event when actor copies are off (BR-NOTIF-5)', async () => {
    const res = await service.handleEvent(approved());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.results.map((r) => r.recipientId)).toEqual(['emp-1']);
  });

  it('is idempotent across redelivery — no duplicate email/in-app (BR-NOTIF-9)', async () => {
    await service.handleEvent(submitted());
    await service.handleEvent(submitted()); // same requestId/type/atMs => same dedupeKey

    expect(email.sent).toHaveLength(2); // not 4
    expect(await inbox.list('emp-1')).toHaveLength(1);
    expect(await inbox.list('lead-1')).toHaveLength(1);
  });

  it('records skipped(RECIPIENT_UNRESOLVED) and never fails the batch (BR-NOTIF-4/8)', async () => {
    const emptyDir = new InMemoryRecipientDirectory(); // resolves nobody
    service = new NotificationService({
      directory: emptyDir,
      email,
      inbox,
      deliveries,
      now: () => 5000,
      newId: () => `notif-${++ids}`,
    });
    const res = await service.handleEvent(submitted());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.results.every((r) => r.outcomes.every((o) => o.reason === 'RECIPIENT_UNRESOLVED'))).toBe(true);
    expect(email.sent).toHaveLength(0);
  });

  it('delivers in-app even when the recipient has no email (graceful degradation BR-NOTIF-6/7)', async () => {
    directory.addContact({ principalId: 'emp-1' }); // overwrite: no email
    const res = await service.handleEvent(approved());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const owner = res.value.results.find((r) => r.recipientId === 'emp-1');
    const emailOutcome = owner?.outcomes.find((o) => o.channel === 'Email');
    const inAppOutcome = owner?.outcomes.find((o) => o.channel === 'InApp');
    expect(emailOutcome?.status).toBe('Skipped');
    expect(emailOutcome?.reason).toBe('NO_EMAIL_CONTACT');
    expect(inAppOutcome?.status).toBe('Delivered');
  });

  it('dead-letters a failing email channel while in-app still lands (BR-NOTIF-7/10)', async () => {
    email.setFailing(true);
    const res = await service.handleEvent(approved());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const owner = res.value.results.find((r) => r.recipientId === 'emp-1');
    expect(owner?.outcomes.find((o) => o.channel === 'Email')?.status).toBe('DeadLettered');
    expect(owner?.outcomes.find((o) => o.channel === 'InApp')?.status).toBe('Delivered');
  });

  it('renders the rejection stage into a PII-free in-app title (BR-PII-1)', async () => {
    const res = await service.handleEvent(rejected());
    expect(res.ok).toBe(true);
    const list = await inbox.list('emp-1');
    expect(list[0]?.title).toContain('TeamLead');
    // No email address / free-text reason leaks into the in-app copy.
    expect(list[0]?.body).not.toContain('@');
  });

  it('appends an append-only delivery record per notified recipient (BR-NOTIF-11)', async () => {
    await service.handleEvent(submitted());
    expect(deliveries.all).toHaveLength(2);
    expect(deliveries.all.every((d) => d.requestId === 'req-1')).toBe(true);
  });

  it('ignores an unknown/unmapped event type as a no-op (fail-closed recipient policy)', async () => {
    const unknown = { ...submitted(), type: 'RequestArchived' } as unknown as RequestSubmitted;
    const res = await service.handleEvent(unknown);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.results).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
  });
});

describe('NotificationService — inbox reader (Workflow N-B, self-scope BR-NOTIF-12)', () => {
  let directory: InMemoryRecipientDirectory;
  let inbox: InMemoryInAppInbox;
  let service: NotificationService;

  beforeEach(async () => {
    directory = new InMemoryRecipientDirectory().addContact({ principalId: 'emp-1', email: 'e@corp.example' });
    inbox = new InMemoryInAppInbox();
    service = new NotificationService({
      directory,
      email: new InMemoryEmailSender(),
      inbox,
      deliveries: new InMemoryNotificationDeliveryRepository(),
      now: () => 5000,
      newId: () => 'notif-1',
    });
    await service.handleEvent(approved()); // seeds one in-app notif for emp-1
  });

  it('lists only the viewer’s own notifications', async () => {
    const res = await service.listForRecipient(viewer);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    expect(res.value[0]?.recipientId).toBe('emp-1');
  });

  it('marks the viewer’s own notification read (idempotent)', async () => {
    const first = await service.markRead(viewer, 'notif-1');
    expect(first.ok).toBe(true);
    const again = await service.markRead(viewer, 'notif-1'); // idempotent
    expect(again.ok).toBe(true);
    const list = await service.listForRecipient(viewer, true);
    expect(list.ok && list.value).toHaveLength(0);
  });

  it('returns NOT_FOUND for an unknown notification id', async () => {
    const res = await service.markRead(viewer, 'does-not-exist');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('returns FORBIDDEN when marking another principal’s notification read (fail-closed)', async () => {
    const other: AuthenticatedPrincipal = { principalId: 'attacker-1', rawClaims: {} };
    const res = await service.markRead(other, 'notif-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('FORBIDDEN');
  });
});
