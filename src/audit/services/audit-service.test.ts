import { describe, it, expect, beforeEach } from 'vitest';
import { AuditService } from './audit-service.js';
import { InMemoryAuditStore } from '../adapters/in-memory-audit-store.js';
import { GENESIS, SEVEN_YEARS_MS, recomputeHash } from '../domain/audit-record.js';
import type { WorkflowEvent } from '../../workflow/domain/events.js';

/** Deterministic id factory so tests can assert stable behaviour. */
function seqIds(): () => string {
  let n = 0;
  return () => `audit-${++n}`;
}

function baseEvent(overrides: Record<string, unknown> = {}): WorkflowEvent {
  return {
    type: 'RequestSubmitted',
    requestId: 'req-1',
    ownerId: 'owner-1',
    department: 'ENG',
    actorId: 'owner-1',
    status: 'Submitted',
    atMs: 1_000,
    ...overrides,
  } as WorkflowEvent;
}

describe('AuditService.recordEvent', () => {
  let store: InMemoryAuditStore;
  let service: AuditService;

  beforeEach(() => {
    store = new InMemoryAuditStore();
    service = new AuditService({ store, clock: () => 5_000, idFactory: seqIds() });
  });

  it('records one AuditRecord for each of the five workflow event types', async () => {
    const events: WorkflowEvent[] = [
      baseEvent({ type: 'RequestSubmitted', status: 'Submitted', requestId: 'r-s', atMs: 1 }),
      baseEvent({ type: 'RequestValidated', status: 'Validated', requestId: 'r-v', atMs: 2 }),
      baseEvent({ type: 'RequestApproved', status: 'Approved', requestId: 'r-a', atMs: 3 }),
      baseEvent({
        type: 'RequestRejected',
        status: 'Rejected',
        requestId: 'r-r',
        atMs: 4,
        rejectedStage: 'HR',
      }),
      baseEvent({ type: 'RequestWithdrawn', status: 'Withdrawn', requestId: 'r-w', atMs: 5 }),
    ];
    for (const event of events) {
      const result = await service.recordEvent(event);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.eventType).toBe(event.type);
    }
  });

  it('maps event fields to the record and sets business + ingest time distinctly', async () => {
    const result = await service.recordEvent(baseEvent({ atMs: 1_234 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.occurredAtMs).toBe(1_234); // business time (event.atMs)
    expect(result.value.recordedAtMs).toBe(5_000); // ingest time (clock)
    expect(result.value.prevHash).toBe(GENESIS);
    expect(result.value.hash).toHaveLength(64); // sha256 hex
  });

  it('stamps retainUntilMs at recordedAt + seven years (BR-AUD-7)', async () => {
    const result = await service.recordEvent(baseEvent());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.retainUntilMs).toBe(5_000 + SEVEN_YEARS_MS);
  });

  it('is idempotent on duplicate delivery (BR-AUD-2)', async () => {
    const event = baseEvent({ atMs: 42 });
    const first = await service.recordEvent(event);
    const second = await service.recordEvent(event);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value.auditId).toBe(first.value.auditId);
    expect(await store.findByRequest('req-1')).toHaveLength(1);
  });

  it('chains records within a request partition (BR-AUD-4, BR-AUD-6)', async () => {
    const r1 = await service.recordEvent(
      baseEvent({ type: 'RequestSubmitted', status: 'Submitted', atMs: 1 }),
    );
    const r2 = await service.recordEvent(
      baseEvent({ type: 'RequestValidated', status: 'Validated', atMs: 2 }),
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.prevHash).toBe(GENESIS);
      expect(r2.value.prevHash).toBe(r1.value.hash);
    }
  });

  it('rejects a malformed event (unknown type) fail-closed with no write (BR-AUD-1)', async () => {
    const result = await service.recordEvent({ ...baseEvent(), type: 'Nope' } as unknown as WorkflowEvent);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MALFORMED_EVENT');
      expect(result.error.field).toBe('type');
    }
    expect(await store.findByRequest('req-1')).toHaveLength(0);
  });

  it('rejects a status/type mismatch (BR-AUD-1a)', async () => {
    const result = await service.recordEvent(
      baseEvent({ type: 'RequestApproved', status: 'Submitted' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('status');
  });

  it('rejects a rejection missing rejectedStage, and a non-rejection carrying it (BR-AUD-1b)', async () => {
    const missing = await service.recordEvent(
      baseEvent({ type: 'RequestRejected', status: 'Rejected', atMs: 7 }),
    );
    expect(missing.ok).toBe(false);
    const spurious = await service.recordEvent(
      baseEvent({ atMs: 8, rejectedStage: 'HR' }),
    );
    expect(spurious.ok).toBe(false);
    if (!missing.ok) expect(missing.error.field).toBe('rejectedStage');
  });

  it('rejects a negative / non-finite atMs (BR-AUD-1)', async () => {
    const result = await service.recordEvent(baseEvent({ atMs: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('atMs');
  });

  it('produces PII-free error codes and messages (BR-AUD-8)', async () => {
    const result = await service.recordEvent(
      baseEvent({ ownerId: '' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain('owner');
      expect(['MALFORMED_EVENT']).toContain(result.error.code);
    }
  });
});

describe('AuditService reads & verifyChain', () => {
  let store: InMemoryAuditStore;
  let service: AuditService;

  beforeEach(async () => {
    store = new InMemoryAuditStore();
    service = new AuditService({ store, clock: () => 9_000, idFactory: seqIds() });
    await service.recordEvent(baseEvent({ type: 'RequestSubmitted', status: 'Submitted', atMs: 1 }));
    await service.recordEvent(baseEvent({ type: 'RequestValidated', status: 'Validated', atMs: 2 }));
  });

  it('returns the ordered trail for a request', async () => {
    const result = await service.getRequestTrail('req-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0].eventType).toBe('RequestSubmitted');
      expect(result.value[1].eventType).toBe('RequestValidated');
    }
  });

  it('returns an empty list for an unknown request (not an error)', async () => {
    const result = await service.getRequestTrail('does-not-exist');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('filters by eventType via queryTrail', async () => {
    const result = await service.queryTrail({ eventType: 'RequestValidated' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].eventType).toBe('RequestValidated');
    }
  });

  it('verifies an intact chain (BR-AUD-6)', async () => {
    const result = await service.verifyChain('req-1');
    expect(result.ok).toBe(true);
  });

  it('detects a tampered record (hash-mismatch)', async () => {
    // Tamper directly at the store to simulate after-the-fact edit.
    const records = await store.findByRequest('req-1');
    const tampered = { ...records[0], department: 'HACKED' } as (typeof records)[number];
    // Recompute to prove the hash no longer matches, then inject via a fresh store.
    expect(recomputeHash(tampered)).not.toBe(tampered.hash);
    const poisoned = new InMemoryAuditStore();
    await poisoned.append(tampered);
    await poisoned.append(records[1]);
    const svc = new AuditService({ store: poisoned });
    const result = await svc.verifyChain('req-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('hash-mismatch');
  });

  it('detects a broken chain link (broken-link)', async () => {
    const records = await store.findByRequest('req-1');
    // Second record's prevHash no longer points at the first record's hash.
    const broken = { ...records[1], prevHash: 'WRONG' } as (typeof records)[number];
    const poisoned = new InMemoryAuditStore();
    await poisoned.append(records[0]);
    // Re-hash the broken record so it fails on the LINK check, not hash-mismatch.
    const rehashed = { ...broken, hash: recomputeHash(broken) } as (typeof records)[number];
    await poisoned.append(rehashed);
    const svc = new AuditService({ store: poisoned });
    const result = await svc.verifyChain('req-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broken-link');
  });

  it('reads are non-mutating — running verifyChain leaves the trail unchanged (BR-AUD-9)', async () => {
    const before = await store.findByRequest('req-1');
    await service.verifyChain('req-1');
    await service.getRequestTrail('req-1');
    const after = await store.findByRequest('req-1');
    expect(after).toEqual(before);
  });
});
