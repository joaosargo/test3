import { describe, it, expect } from 'vitest';
import { WorkflowPendingQueryAdapter } from './workflow-pending-query-adapter.js';
import { IntervalScheduler } from './interval-scheduler.js';
import { InMemoryVacationRequestRepository } from '../../workflow/adapters/in-memory-vacation-request-repository.js';
import { VacationRequest } from '../../workflow/domain/vacation-request.js';

/**
 * Unit tests for the read-only workflow pending query adapter (`BR-SLA-1/2/9`)
 * and the in-process interval scheduler (`BR-SLA-6/8`). Both use in-memory
 * doubles / injected clocks for determinism.
 */

const DEPT = 'engineering';

async function seedRepo(): Promise<InMemoryVacationRequestRepository> {
  const repo = new InMemoryVacationRequestRepository();
  // A submitted request (awaiting TeamLead) entered at 1000.
  await repo.save(
    VacationRequest.submit({
      id: 'req-sub',
      ownerId: 'emp-1',
      department: DEPT,
      dates: { startDate: '2026-10-01', endDate: '2026-10-05' },
      atMs: 1000,
    }),
  );
  // A validated request (awaiting HR) — submit (persist v1) then validate at 3000.
  const submitted = VacationRequest.submit({
    id: 'req-val',
    ownerId: 'emp-2',
    department: DEPT,
    dates: { startDate: '2026-11-01', endDate: '2026-11-03' },
    atMs: 2000,
  });
  await repo.save(submitted);
  const validated = submitted.validate('lead-1', 3000);
  if (validated.ok) await repo.save(validated.value);
  // A terminal (withdrawn) request — must be excluded (BR-SLA-9).
  const toWithdraw = VacationRequest.submit({
    id: 'req-wd',
    ownerId: 'emp-3',
    department: DEPT,
    dates: { startDate: '2026-12-01', endDate: '2026-12-02' },
    atMs: 500,
  });
  await repo.save(toWithdraw);
  const withdrawn = toWithdraw.withdraw('emp-3', 600);
  if (withdrawn.ok) await repo.save(withdrawn.value);
  return repo;
}

describe('WorkflowPendingQueryAdapter (BR-SLA-1/2/9)', () => {
  it('lists only awaiting-actor requests with the per-stage clock timestamp', async () => {
    const repo = await seedRepo();
    const adapter = new WorkflowPendingQueryAdapter({ repository: repo, departments: () => [DEPT] });
    const views = await adapter.listPending();

    const byId = Object.fromEntries(views.map((v) => [v.requestId, v]));
    expect(Object.keys(byId).sort()).toEqual(['req-sub', 'req-val']); // no req-wd (terminal)
    expect(byId['req-sub']!.status).toBe('Submitted');
    expect(byId['req-sub']!.enteredCurrentStatusAtMs).toBe(1000);
    // The HR clock starts at the Validated transition, not the original submit.
    expect(byId['req-val']!.status).toBe('Validated');
    expect(byId['req-val']!.enteredCurrentStatusAtMs).toBe(3000);
  });

  it('findById returns a view for a pending request and null for a terminal one', async () => {
    const repo = await seedRepo();
    const adapter = new WorkflowPendingQueryAdapter({ repository: repo, departments: () => [DEPT] });
    expect((await adapter.findById('req-sub'))!.requestId).toBe('req-sub');
    expect(await adapter.findById('req-wd')).toBeNull(); // terminal, out of scope
    expect(await adapter.findById('nope')).toBeNull();
  });
});

describe('IntervalScheduler (BR-SLA-6/8)', () => {
  it('drives the registered handler on a manual tick with an explicit clock', async () => {
    const scheduler = new IntervalScheduler({ intervalMs: 60_000, now: () => 42 });
    const seen: number[] = [];
    scheduler.onTick(async (nowMs) => {
      seen.push(nowMs);
    });
    await scheduler.tick(); // uses injected now -> 42
    await scheduler.tick(100); // explicit
    scheduler.stop();
    expect(seen).toEqual([42, 100]);
  });

  it('tick is a no-op before a handler is registered', async () => {
    const scheduler = new IntervalScheduler({ intervalMs: 1000 });
    await expect(scheduler.tick(1)).resolves.toBeUndefined();
    scheduler.stop();
  });
});
