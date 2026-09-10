import { describe, it, expect } from 'vitest';
import { WorkflowService } from '../workflow/services/workflow-service.js';
import { InMemoryVacationRequestRepository } from '../workflow/adapters/in-memory-vacation-request-repository.js';
import { InMemoryEventPublisher } from '../workflow/adapters/in-memory-event-publisher.js';
import { AuthzService, InMemoryRoleDirectory } from '../authz/index.js';
import type { AuthenticatedPrincipal } from '../domain/entities.js';
import { NotificationService } from './services/notification-service.js';
import { InMemoryRecipientDirectory } from './adapters/in-memory-recipient-directory.js';
import { InMemoryEmailSender } from './adapters/in-memory-email-sender.js';
import { InMemoryInAppInbox } from './adapters/in-memory-in-app-inbox.js';
import { InMemoryNotificationDeliveryRepository } from './adapters/in-memory-notification-delivery-repository.js';
import { registerNotificationSubscriber } from './subscribe.js';

/**
 * Integration test for the choreography seam: the notification unit subscribes
 * to the workflow's `EventPublisher` and reacts to real transitions produced by
 * the shipped `WorkflowService` — never calling the workflow back
 * (business-logic-model Data Flow; `BR-NOTIF-8` non-blocking). This exercises
 * the boundary between unit-request-workflow (dependency) and this unit.
 */

const DEPT = 'engineering';

function principal(id: string, role: string): AuthenticatedPrincipal {
  return { principalId: id, rawClaims: { role, department: DEPT } };
}

const employee = principal('emp-1', 'employee');
const lead = principal('lead-1', 'team-lead');
const hr = principal('hr-1', 'hr');
const FUTURE = { startDate: '2999-06-01', endDate: '2999-06-05' };

describe('notification ⇄ workflow choreography integration', () => {
  it('accrues owner + next-actor notifications as the workflow transitions', async () => {
    const repository = new InMemoryVacationRequestRepository();
    const events = new InMemoryEventPublisher();
    let reqIds = 0;
    const workflow = new WorkflowService({
      repository,
      events,
      authz: new AuthzService({ directory: new InMemoryRoleDirectory() }),
      now: () => 1_000_000,
      newId: () => `req-${++reqIds}`,
    });

    const directory = new InMemoryRecipientDirectory()
      .addContact({ principalId: 'emp-1', email: 'emp1@corp.example', displayName: 'Emma' })
      .addContact({ principalId: 'lead-1', email: 'lead1@corp.example', displayName: 'Liam' })
      .addContact({ principalId: 'hr-1', email: 'hr1@corp.example', displayName: 'Hannah' })
      .assignActor(DEPT, 'team-lead', 'lead-1')
      .assignActor(DEPT, 'hr', 'hr-1');
    const email = new InMemoryEmailSender();
    const inbox = new InMemoryInAppInbox();
    let notifIds = 0;
    const notifications = new NotificationService({
      directory,
      email,
      inbox,
      deliveries: new InMemoryNotificationDeliveryRepository(),
      now: () => 2_000_000,
      newId: () => `notif-${++notifIds}`,
    });

    // Wire the choreography: notification subscribes to workflow events.
    registerNotificationSubscriber(events, notifications);

    // Drive submit -> validate -> approve.
    const submitted = await workflow.submitRequest(employee, FUTURE);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const id = submitted.value.id;

    await workflow.leadDecision(lead, 'validate', { requestId: id, expectedVersion: 1 });
    await workflow.hrDecision(hr, 'approve', { requestId: id, expectedVersion: 2 });

    // Owner saw submitted + validated (progress) + approved = 3 in-app items.
    const ownerInbox = await inbox.list('emp-1');
    expect(ownerInbox.map((n) => n.eventType)).toEqual(
      expect.arrayContaining(['RequestSubmitted', 'RequestValidated', 'RequestApproved']),
    );
    // Team lead was notified on submit; HR on validate (next-actor, BR-NOTIF-3).
    expect(await inbox.list('lead-1')).toHaveLength(1);
    expect(await inbox.list('hr-1')).toHaveLength(1);
    // Emails were dispatched for the notified recipients.
    expect(email.sent.length).toBeGreaterThanOrEqual(3);
  });

  it('a notification-channel failure never blocks the workflow transition (BR-NOTIF-8)', async () => {
    const repository = new InMemoryVacationRequestRepository();
    const events = new InMemoryEventPublisher();
    let reqIds = 0;
    const workflow = new WorkflowService({
      repository,
      events,
      authz: new AuthzService({ directory: new InMemoryRoleDirectory() }),
      now: () => 1_000_000,
      newId: () => `req-${++reqIds}`,
    });

    const directory = new InMemoryRecipientDirectory()
      .addContact({ principalId: 'emp-1', email: 'emp1@corp.example' })
      .assignActor(DEPT, 'team-lead', 'lead-1');
    const email = new InMemoryEmailSender().setFailing(true); // channel down
    const inbox = new InMemoryInAppInbox().setFailing(true); // channel down
    const notifications = new NotificationService({
      directory,
      email,
      inbox,
      deliveries: new InMemoryNotificationDeliveryRepository(),
      now: () => 2_000_000,
      newId: () => 'notif-1',
    });
    registerNotificationSubscriber(events, notifications);

    // Despite both channels failing, the submit transition still commits.
    const submitted = await workflow.submitRequest(employee, FUTURE);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.status).toBe('Submitted');
  });
});
