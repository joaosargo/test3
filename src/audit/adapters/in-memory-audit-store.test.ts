import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAuditStore } from './in-memory-audit-store.js';
import { createAuditRecord, GENESIS, type AuditableEvent } from '../domain/audit-record.js';

let seq = 0;
function makeRecord(overrides: Partial<AuditableEvent> = {}, prevHash = GENESIS) {
  const event: AuditableEvent = {
    type: 'RequestSubmitted',
    requestId: 'req-1',
    ownerId: 'owner-1',
    department: 'ENG',
    actorId: 'owner-1',
    status: 'Submitted',
    atMs: 100,
    ...overrides,
  };
  return createAuditRecord(event, prevHash, 1_000, () => `a-${++seq}`);
}

describe('InMemoryAuditStore', () => {
  let store: InMemoryAuditStore;

  beforeEach(() => {
    seq = 0;
    store = new InMemoryAuditStore();
  });

  it('appends and reads back records in append order', async () => {
    const r1 = makeRecord({ atMs: 1 });
    const r2 = makeRecord({ type: 'RequestValidated', status: 'Validated', atMs: 2 }, r1.hash);
    await store.append(r1);
    await store.append(r2);
    const partition = await store.findByRequest('req-1');
    expect(partition.map((r) => r.eventType)).toEqual(['RequestSubmitted', 'RequestValidated']);
  });

  it('tracks the chain head hash as the last appended record', async () => {
    expect(await store.chainHead('req-1')).toBeNull();
    const r1 = makeRecord({ atMs: 1 });
    await store.append(r1);
    expect(await store.chainHead('req-1')).toBe(r1.hash);
  });

  it('finds a record by its dedup key (BR-AUD-2)', async () => {
    const r1 = makeRecord({ atMs: 7 });
    await store.append(r1);
    const found = await store.findByKey('RequestSubmitted', 'req-1', 7);
    expect(found?.auditId).toBe(r1.auditId);
    expect(await store.findByKey('RequestSubmitted', 'req-1', 8)).toBeNull();
  });

  it('applies query filters (department + eventType)', async () => {
    await store.append(makeRecord({ department: 'ENG', atMs: 1 }));
    await store.append(
      makeRecord({ department: 'SALES', requestId: 'req-2', atMs: 2 }),
    );
    const eng = await store.query({ department: 'ENG' });
    expect(eng).toHaveLength(1);
    expect(eng[0].department).toBe('ENG');
  });

  it('does not expose the internal partition for mutation', async () => {
    const r1 = makeRecord({ atMs: 1 });
    await store.append(r1);
    const partition = await store.findByRequest('req-1');
    partition.push(makeRecord({ atMs: 99 }));
    // Mutating the returned copy must not affect the store.
    expect(await store.findByRequest('req-1')).toHaveLength(1);
  });

  it('freezes stored records (BR-AUD-5a immutability)', async () => {
    const r1 = makeRecord({ atMs: 1 });
    await store.append(r1);
    const [stored] = await store.findByRequest('req-1');
    expect(Object.isFrozen(stored)).toBe(true);
  });
});
