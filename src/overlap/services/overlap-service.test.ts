import { describe, it, expect } from 'vitest';
import {
  VacationRequest,
  type DateRange,
  type RequestStatus,
  type VacationRequestState,
  type VacationRequestRepository,
} from '../../workflow/index.js';
import { OverlapService } from './overlap-service.js';

/**
 * Unit tests for OverlapService — the pure read-side projection.
 *
 * Covers the business scenarios / rules from business-logic-model and
 * business-rules: overlap present (BR-OV-1), no overlap, rejected/withdrawn
 * excluded (BR-OV-3), self-exclusion (BR-OV-4), competing-status inclusion,
 * PII-free summary (BR-PII-1), not-found (BR-ADV-3), and fail-open on a read
 * seam fault (BR-ADV-3). Uses the real InMemoryVacationRequestRepository so the
 * tests exercise the genuine consumed read seam (INV-OV-3).
 */

const DEPT = 'engineering';

/** Build a persisted request in a chosen status/range for fixtures. */
function requestState(
  id: string,
  dates: DateRange,
  status: RequestStatus,
  department = DEPT,
): VacationRequestState {
  return {
    id,
    ownerId: `owner-${id}`,
    department,
    dates,
    status,
    history: [{ from: null, to: 'Submitted', actorId: `owner-${id}`, atMs: 0 }],
    version: 1,
  };
}

/** Seed a read-only repository with the given request states. */
async function seed(states: VacationRequestState[]): Promise<VacationRequestRepository> {
  return new SeededRepository(states);
}

/** A trivial read-only repository seeded from fixed states (test double). */
class SeededRepository implements VacationRequestRepository {
  private readonly byId = new Map<string, VacationRequestState>();
  constructor(states: VacationRequestState[]) {
    for (const s of states) this.byId.set(s.id, s);
  }
  async save(): Promise<never> {
    throw new Error('read-only test double');
  }
  async findById(id: string): Promise<VacationRequest | null> {
    const s = this.byId.get(id);
    return s ? VacationRequest.fromState(s) : null;
  }
  async findByOwner(): Promise<readonly VacationRequest[]> {
    return [];
  }
  async findByDepartmentAndStatus(
    department: string,
    status: RequestStatus,
  ): Promise<readonly VacationRequest[]> {
    return [...this.byId.values()]
      .filter((s) => s.department === department && s.status === status)
      .map((s) => VacationRequest.fromState(s));
  }
}

describe('OverlapService.computeOverlap', () => {
  const reviewedWindow: DateRange = { startDate: '2999-06-10', endDate: '2999-06-14' };

  it('counts competing requests that overlap the reviewed window (BR-OV-1)', async () => {
    const repo = await seed([
      requestState('R', reviewedWindow, 'Submitted'),
      requestState('a', { startDate: '2999-06-12', endDate: '2999-06-18' }, 'Approved'),
      requestState('b', { startDate: '2999-06-14', endDate: '2999-06-20' }, 'Validated'),
    ]);
    const service = new OverlapService({ repository: repo });

    const result = await service.computeOverlap('R');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.overlapCount).toBe(2);
    expect(result.value.hasOverlap).toBe(true);
    expect([...result.value.overlappingIds].sort()).toEqual(['a', 'b']);
    expect(result.value.window).toEqual(reviewedWindow);
  });

  it('returns no overlap when nothing intersects the window (BR-OV-5)', async () => {
    const repo = await seed([
      requestState('R', reviewedWindow, 'Submitted'),
      requestState('far', { startDate: '2999-07-01', endDate: '2999-07-05' }, 'Approved'),
    ]);
    const service = new OverlapService({ repository: repo });

    const result = await service.computeOverlap('R');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.overlapCount).toBe(0);
    expect(result.value.hasOverlap).toBe(false);
    expect(result.value.overlappingIds).toEqual([]);
  });

  it('excludes Rejected and Withdrawn neighbours (BR-OV-3)', async () => {
    const repo = await seed([
      requestState('R', reviewedWindow, 'Submitted'),
      requestState('rej', { startDate: '2999-06-11', endDate: '2999-06-13' }, 'Rejected'),
      requestState('wd', { startDate: '2999-06-12', endDate: '2999-06-13' }, 'Withdrawn'),
    ]);
    const service = new OverlapService({ repository: repo });

    const result = await service.computeOverlap('R');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.overlapCount).toBe(0);
  });

  it('never counts the reviewed request against itself (BR-OV-4)', async () => {
    const repo = await seed([requestState('R', reviewedWindow, 'Submitted')]);
    const service = new OverlapService({ repository: repo });

    const result = await service.computeOverlap('R');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.overlapCount).toBe(0);
    expect(result.value.overlappingIds).not.toContain('R');
  });

  it('carries only counts and opaque ids — no PII (BR-PII-1)', async () => {
    const repo = await seed([
      requestState('R', reviewedWindow, 'Submitted'),
      requestState('a', { startDate: '2999-06-12', endDate: '2999-06-18' }, 'Approved'),
    ]);
    const service = new OverlapService({ repository: repo });

    const result = await service.computeOverlap('R');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = Object.keys(result.value).sort();
    expect(keys).toEqual(['hasOverlap', 'overlapCount', 'overlappingIds', 'window']);
    // overlappingIds are opaque request ids, not owner identities (BR-PII-2).
    expect(result.value.overlappingIds).toEqual(['a']);
  });

  it('returns NOT_FOUND for an unknown reviewed request (BR-ADV-3)', async () => {
    const repo = await seed([]);
    const service = new OverlapService({ repository: repo });

    const result = await service.computeOverlap('missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('fails open with READ_FAILED when the read seam throws (BR-ADV-3)', async () => {
    const throwingRepo: VacationRequestRepository = {
      async save() {
        throw new Error('unused');
      },
      async findById() {
        throw new Error('boom');
      },
      async findByOwner() {
        return [];
      },
      async findByDepartmentAndStatus() {
        return [];
      },
    };
    const service = new OverlapService({ repository: throwingRepo });

    const result = await service.computeOverlap('R');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('READ_FAILED');
  });

  it('only considers the reviewed department (BR-OV-2)', async () => {
    const repo = await seed([
      requestState('R', reviewedWindow, 'Submitted', 'engineering'),
      requestState('other', reviewedWindow, 'Approved', 'sales'),
    ]);
    const service = new OverlapService({ repository: repo });

    const result = await service.computeOverlap('R');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.overlapCount).toBe(0);
  });
});
