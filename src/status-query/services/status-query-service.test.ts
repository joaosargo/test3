import { describe, it, expect } from 'vitest';
import { StatusQueryService } from './status-query-service.js';
import { InMemoryVacationRequestRepository } from '../../workflow/adapters/in-memory-vacation-request-repository.js';
import { VacationRequest } from '../../workflow/domain/vacation-request.js';
import { AuthzService, InMemoryRoleDirectory } from '../../authz/index.js';
import type { AuthenticatedPrincipal } from '../../domain/entities.js';

/**
 * Unit tests for StatusQueryService — the CQRS read side (story-status-tracking,
 * req-status-tracking). Exercises the guarded-read contract: fail-closed
 * authorization (BR-SQ-1), least-privilege permission by intent (BR-SQ-2),
 * defence-in-depth scope filtering (BR-SQ-5), reason role-gating (BR-SQ-6),
 * deterministic ordering (BR-SQ-10), chronological timeline (BR-SQ-11), and
 * input validation (BR-SQ-12..14).
 *
 * The authz PDP is the real shipped `AuthzService`; role/department are sourced
 * from the principal's claims (claims-first, no directory), so these tests
 * cover the true authorization path end-to-end without mocking the decision.
 */

function principal(id: string, role: string, department?: string): AuthenticatedPrincipal {
  return {
    principalId: id,
    rawClaims: { role, ...(department !== undefined ? { department } : {}) },
  };
}

function newService() {
  const repo = new InMemoryVacationRequestRepository();
  const authz = new AuthzService({ directory: new InMemoryRoleDirectory() });
  const service = new StatusQueryService({ repo, authz });
  return { repo, authz, service };
}

/** Seed a request through the aggregate + repo, advancing it through transitions. */
async function seed(
  repo: InMemoryVacationRequestRepository,
  opts: {
    id: string;
    ownerId: string;
    department: string;
    dates?: { startDate: string; endDate: string };
    validateAtMs?: number;
    submitAtMs?: number;
  },
): Promise<void> {
  const dates = opts.dates ?? { startDate: '2999-06-01', endDate: '2999-06-05' };
  let request = VacationRequest.submit({
    id: opts.id,
    ownerId: opts.ownerId,
    department: opts.department,
    dates,
    atMs: opts.submitAtMs ?? 1000,
  });
  await repo.save(request);
  if (opts.validateAtMs !== undefined) {
    const validated = request.validate('lead-x', opts.validateAtMs, 'looks good');
    if (validated.ok) {
      request = validated.value;
      await repo.save(request);
    }
  }
}

describe('StatusQueryService.listOwnRequests', () => {
  it('returns the caller\'s own summaries ordered by lastUpdatedAtMs desc', async () => {
    const { repo, service } = newService();
    await seed(repo, { id: 'r1', ownerId: 'emp-1', department: 'eng', submitAtMs: 1000 });
    await seed(repo, { id: 'r2', ownerId: 'emp-1', department: 'eng', submitAtMs: 2000 });
    await seed(repo, { id: 'r3', ownerId: 'other', department: 'eng', submitAtMs: 3000 });

    const result = await service.listOwnRequests(principal('emp-1', 'employee', 'eng'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((v) => v.id)).toEqual(['r2', 'r1']); // newest-updated first
    // Summary rows never carry a reason field (BR-SQ-9).
    expect(result.value.every((v) => !('reason' in v))).toBe(true);
  });

  it('applies an optional status filter', async () => {
    const { repo, service } = newService();
    await seed(repo, { id: 'r1', ownerId: 'emp-1', department: 'eng', submitAtMs: 1000 });
    await seed(repo, { id: 'r2', ownerId: 'emp-1', department: 'eng', submitAtMs: 1000, validateAtMs: 2000 });

    const result = await service.listOwnRequests(principal('emp-1', 'employee', 'eng'), {
      status: 'Validated',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((v) => v.id)).toEqual(['r2']);
  });

  it('fails closed with FORBIDDEN when the PDP denies (unknown role)', async () => {
    const { repo, service } = newService();
    await seed(repo, { id: 'r1', ownerId: 'emp-1', department: 'eng' });
    const result = await service.listOwnRequests(principal('emp-1', 'wizard', 'eng'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FORBIDDEN');
  });

  it('rejects an unknown status filter with INVALID_INPUT', async () => {
    const { service } = newService();
    const result = await service.listOwnRequests(principal('emp-1', 'employee', 'eng'), {
      status: 'Nope' as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.field).toBe('status');
  });
});

describe('StatusQueryService.listScopedRequests', () => {
  it('returns an HR department view (default Validated) scoped to the grant', async () => {
    const { repo, service } = newService();
    await seed(repo, { id: 'r1', ownerId: 'emp-1', department: 'eng', validateAtMs: 2000 });
    await seed(repo, { id: 'r2', ownerId: 'emp-2', department: 'sales', validateAtMs: 2000 });

    const result = await service.listScopedRequests(principal('hr-1', 'hr', 'eng'), 'hr', 'eng');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((v) => v.id)).toEqual(['r1']); // sales row out of scope
  });

  it('denies an HR view for a department outside scope (FORBIDDEN)', async () => {
    const { repo, service } = newService();
    await seed(repo, { id: 'r1', ownerId: 'emp-1', department: 'sales', validateAtMs: 2000 });
    const result = await service.listScopedRequests(principal('hr-1', 'hr', 'eng'), 'hr', 'sales');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FORBIDDEN');
  });

  it('orders a team-lead queue oldest-first (submittedAtMs asc)', async () => {
    const { repo, service } = newService();
    await seed(repo, { id: 'r-late', ownerId: 'emp-1', department: 'eng', submitAtMs: 5000 });
    await seed(repo, { id: 'r-early', ownerId: 'emp-2', department: 'eng', submitAtMs: 1000 });
    const result = await service.listScopedRequests(
      principal('lead-1', 'team-lead', 'eng'),
      'team-lead',
      'eng',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((v) => v.id)).toEqual(['r-early', 'r-late']);
  });

  it('requires a department (INVALID_INPUT)', async () => {
    const { service } = newService();
    const result = await service.listScopedRequests(principal('hr-1', 'hr', 'eng'), 'hr', '');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.field).toBe('department');
  });
});

describe('StatusQueryService.getRequestTimeline', () => {
  it('projects the full chronological timeline with reasons for the owner (BR-SQ-6/11)', async () => {
    const { repo, service } = newService();
    await seed(repo, { id: 'r1', ownerId: 'emp-1', department: 'eng', submitAtMs: 1000, validateAtMs: 2000 });
    const result = await service.getRequestTimeline(principal('emp-1', 'employee', 'eng'), 'r1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('Validated');
    expect(result.value.timeline.map((t) => t.to)).toEqual(['Submitted', 'Validated']);
    // The owner sees the validate reason (BR-SQ-6).
    expect(result.value.timeline[1].reason).toBe('looks good');
  });

  it('returns NOT_FOUND for an unknown id', async () => {
    const { service } = newService();
    const result = await service.getRequestTimeline(principal('emp-1', 'employee', 'eng'), 'nope');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('lets an in-scope HR approver read a timeline (non-owner path)', async () => {
    const { repo, service } = newService();
    await seed(repo, { id: 'r1', ownerId: 'emp-1', department: 'eng', validateAtMs: 2000 });
    const result = await service.getRequestTimeline(principal('hr-1', 'hr', 'eng'), 'r1');
    expect(result.ok).toBe(true);
  });

  it('denies a non-owner employee from another department (FORBIDDEN, existence not confirmed)', async () => {
    const { repo, service } = newService();
    await seed(repo, { id: 'r1', ownerId: 'emp-1', department: 'eng', validateAtMs: 2000 });
    const result = await service.getRequestTimeline(principal('emp-2', 'employee', 'eng'), 'r1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FORBIDDEN');
  });

  it('requires a non-empty request id (INVALID_INPUT)', async () => {
    const { service } = newService();
    const result = await service.getRequestTimeline(principal('emp-1', 'employee', 'eng'), '');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.field).toBe('requestId');
  });
});
