import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowService } from './workflow-service.js';
import { InMemoryVacationRequestRepository } from '../adapters/in-memory-vacation-request-repository.js';
import { InMemoryEventPublisher } from '../adapters/in-memory-event-publisher.js';
import { AuthzService, InMemoryRoleDirectory } from '../../authz/index.js';
import type { AuthenticatedPrincipal } from '../../domain/entities.js';

/**
 * Unit tests for `WorkflowService` — the orchestrated command path
 * (business-logic-model Workflows A/B/C; business-rules BR-WF-7/8). Uses the
 * real AuthzService PDP with claim-carrying principals (mirrors the authz unit
 * tests) plus in-memory repository / event adapters. Clock and id generator are
 * injected for determinism.
 */

function principal(id: string, role: string, department = 'engineering'): AuthenticatedPrincipal {
  return { principalId: id, rawClaims: { role, department } };
}

const employee = principal('emp-1', 'employee');
const lead = principal('lead-1', 'team-lead');
const hr = principal('hr-1', 'hr');

const FUTURE = { startDate: '2999-06-01', endDate: '2999-06-05' };

describe('WorkflowService — command path', () => {
  let repository: InMemoryVacationRequestRepository;
  let events: InMemoryEventPublisher;
  let service: WorkflowService;
  let ids: number;

  beforeEach(() => {
    repository = new InMemoryVacationRequestRepository();
    events = new InMemoryEventPublisher();
    ids = 0;
    service = new WorkflowService({
      repository,
      events,
      authz: new AuthzService({ directory: new InMemoryRoleDirectory() }),
      now: () => 1_000_000, // fixed clock; well before FUTURE dates
      newId: () => `req-${++ids}`,
    });
  });

  // --- Happy path: submit -> validate -> approve ---

  it('an employee submits a request; it lands Submitted and emits RequestSubmitted', async () => {
    const res = await service.submitRequest(employee, FUTURE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('Submitted');
    expect(events.events.at(-1)?.type).toBe('RequestSubmitted');
  });

  it('drives the full two-stage happy path with event-per-transition (BR-INV-5)', async () => {
    const submitted = await service.submitRequest(employee, FUTURE);
    if (!submitted.ok) return;
    const validated = await service.leadDecision(lead, 'validate', {
      requestId: submitted.value.id,
      expectedVersion: 1,
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const approved = await service.hrDecision(hr, 'approve', {
      requestId: submitted.value.id,
      expectedVersion: 2,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.status).toBe('Approved');
    expect(events.events.map((e) => e.type)).toEqual([
      'RequestSubmitted',
      'RequestValidated',
      'RequestApproved',
    ]);
  });

  // --- Rejections ---

  it('a team lead can reject a submitted request (RequestRejected, TeamLead)', async () => {
    const submitted = await service.submitRequest(employee, FUTURE);
    if (!submitted.ok) return;
    const rejected = await service.leadDecision(lead, 'reject', {
      requestId: submitted.value.id,
      expectedVersion: 1,
      reason: 'insufficient coverage',
    });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.status).toBe('Rejected');
    expect(rejected.value.rejectedStage).toBe('TeamLead');
  });

  // --- Authorization (fail closed, BR-WF-7) ---

  it('denies submit for a principal with no resolvable role (FORBIDDEN)', async () => {
    const res = await service.submitRequest({ principalId: 'x', rawClaims: {} }, FUTURE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('denies an employee acting as HR (approve) — PERMISSION_DENIED -> FORBIDDEN', async () => {
    const submitted = await service.submitRequest(employee, FUTURE);
    if (!submitted.ok) return;
    await service.leadDecision(lead, 'validate', { requestId: submitted.value.id, expectedVersion: 1 });
    const res = await service.hrDecision(employee, 'approve', {
      requestId: submitted.value.id,
      expectedVersion: 2,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('denies HR outside the department scope (DEPARTMENT_OUT_OF_SCOPE -> FORBIDDEN)', async () => {
    const submitted = await service.submitRequest(employee, FUTURE); // engineering
    if (!submitted.ok) return;
    await service.leadDecision(lead, 'validate', { requestId: submitted.value.id, expectedVersion: 1 });
    const otherHr = principal('hr-2', 'hr', 'sales');
    const res = await service.hrDecision(otherHr, 'approve', {
      requestId: submitted.value.id,
      expectedVersion: 2,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });

  // --- State + concurrency guards ---

  it('returns NOT_FOUND for an unknown request id', async () => {
    const res = await service.leadDecision(lead, 'validate', { requestId: 'nope', expectedVersion: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NOT_FOUND');
  });

  it('HR approving a still-Submitted request is ILLEGAL_TRANSITION (BR-WF-2)', async () => {
    const submitted = await service.submitRequest(employee, FUTURE);
    if (!submitted.ok) return;
    const res = await service.hrDecision(hr, 'approve', {
      requestId: submitted.value.id,
      expectedVersion: 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('a stale expectedVersion is rejected with STALE_STATE (BR-INV-3)', async () => {
    const submitted = await service.submitRequest(employee, FUTURE);
    if (!submitted.ok) return;
    const res = await service.leadDecision(lead, 'validate', {
      requestId: submitted.value.id,
      expectedVersion: 99,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('STALE_STATE');
  });

  it('a second concurrent approver loses the version race (STALE_STATE)', async () => {
    const submitted = await service.submitRequest(employee, FUTURE);
    if (!submitted.ok) return;
    await service.leadDecision(lead, 'validate', { requestId: submitted.value.id, expectedVersion: 1 });
    const first = await service.hrDecision(hr, 'approve', { requestId: submitted.value.id, expectedVersion: 2 });
    expect(first.ok).toBe(true);
    const second = await service.hrDecision(hr, 'approve', { requestId: submitted.value.id, expectedVersion: 2 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('STALE_STATE');
  });

  // --- Input validation (BR-VAL-*) ---

  it('rejects an inverted date range with INVALID_INPUT on endDate (BR-VAL-2)', async () => {
    const res = await service.submitRequest(employee, { startDate: '2999-06-10', endDate: '2999-06-01' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_INPUT');
      expect(res.error.field).toBe('endDate');
    }
  });

  it('rejects a past start date with INVALID_INPUT on startDate (BR-VAL-3)', async () => {
    // Use a service whose clock reads 2100-01-01 so a 2099 date is in the past.
    const clocked = new WorkflowService({
      repository,
      events,
      authz: new AuthzService({ directory: new InMemoryRoleDirectory() }),
      now: () => Date.parse('2100-01-01T00:00:00Z'),
    });
    const res = await clocked.submitRequest(employee, { startDate: '2099-12-30', endDate: '2099-12-31' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.field).toBe('startDate');
  });

  it('rejects a malformed date with INVALID_INPUT (BR-VAL-1)', async () => {
    const res = await service.submitRequest(employee, { startDate: 'not-a-date', endDate: '2999-06-05' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_INPUT');
  });

  // --- Withdraw (BR-WF-9) ---

  it('the owner can withdraw a still-Submitted request', async () => {
    const submitted = await service.submitRequest(employee, FUTURE);
    if (!submitted.ok) return;
    const res = await service.withdrawRequest(employee, {
      requestId: submitted.value.id,
      expectedVersion: 1,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('Withdrawn');
  });

  it('a non-owner cannot withdraw someone else\'s request (FORBIDDEN)', async () => {
    const submitted = await service.submitRequest(employee, FUTURE);
    if (!submitted.ok) return;
    const otherEmployee = principal('emp-2', 'employee');
    const res = await service.withdrawRequest(otherEmployee, {
      requestId: submitted.value.id,
      expectedVersion: 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });
});
