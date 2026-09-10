import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryInAppInbox } from './in-memory-in-app-inbox.js';
import type { InAppNotification } from '../domain/entities.js';

/**
 * Unit tests for the in-memory in-app inbox adapter — idempotency
 * (`BR-NOTIF-9`), self-scoped newest-first listing, and idempotent mark-read
 * (`BR-NOTIF-12`).
 */

function notif(overrides: Partial<InAppNotification> = {}): InAppNotification {
  return {
    id: 'n-1',
    recipientId: 'emp-1',
    requestId: 'req-1',
    eventType: 'RequestSubmitted',
    title: 'Vacation request submitted',
    body: 'body',
    dedupeKey: 'dk-1',
    read: false,
    createdAtMs: 1000,
    ...overrides,
  };
}

describe('InMemoryInAppInbox', () => {
  let inbox: InMemoryInAppInbox;

  beforeEach(() => {
    inbox = new InMemoryInAppInbox();
  });

  it('put is idempotent on (recipientId, dedupeKey) (BR-NOTIF-9)', async () => {
    await inbox.put(notif({ id: 'n-1' }));
    await inbox.put(notif({ id: 'n-2' })); // same recipient + dedupeKey
    expect(await inbox.list('emp-1')).toHaveLength(1);
  });

  it('lists only the given recipient, newest-first', async () => {
    await inbox.put(notif({ id: 'n-1', dedupeKey: 'a', createdAtMs: 1000 }));
    await inbox.put(notif({ id: 'n-2', dedupeKey: 'b', createdAtMs: 3000 }));
    await inbox.put(notif({ id: 'n-3', dedupeKey: 'c', recipientId: 'other', createdAtMs: 2000 }));
    const list = await inbox.list('emp-1');
    expect(list.map((n) => n.id)).toEqual(['n-2', 'n-1']);
  });

  it('filters unread when unreadOnly is set', async () => {
    await inbox.put(notif({ id: 'n-1', dedupeKey: 'a' }));
    await inbox.markRead('n-1');
    expect(await inbox.list('emp-1', true)).toHaveLength(0);
    expect(await inbox.list('emp-1', false)).toHaveLength(1);
  });

  it('markRead is idempotent and errors NOT_FOUND on unknown id', async () => {
    await inbox.put(notif({ id: 'n-1' }));
    expect((await inbox.markRead('n-1')).ok).toBe(true);
    expect((await inbox.markRead('n-1')).ok).toBe(true); // idempotent
    const missing = await inbox.markRead('nope');
    expect(missing.ok).toBe(false);
  });

  it('reports channel error when in a failing mode', async () => {
    inbox.setFailing(true);
    const res = await inbox.put(notif());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('CHANNEL_ERROR');
  });
});
