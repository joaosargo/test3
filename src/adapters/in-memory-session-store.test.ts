import { describe, it, expect } from 'vitest';
import { InMemorySessionStore } from './in-memory-session-store.js';
import type { PendingLogin } from '../domain/entities.js';

function pending(state: string, at: number): PendingLogin {
  return { state, nonce: `n-${state}`, codeVerifier: `v-${state}`, returnUrl: '/', createdAt: at };
}

describe('InMemorySessionStore', () => {
  it('takePendingLogin returns and consumes a stored login (single-use)', async () => {
    const store = new InMemorySessionStore({ clock: () => 1000 });
    await store.putPendingLogin(pending('s1', 1000));
    const first = await store.takePendingLogin('s1');
    expect(first?.state).toBe('s1');
    const second = await store.takePendingLogin('s1');
    expect(second).toBeNull();
  });

  it('takePendingLogin returns null for an unknown state', async () => {
    const store = new InMemorySessionStore();
    expect(await store.takePendingLogin('nope')).toBeNull();
  });

  it('takePendingLogin returns null for an expired pending login', async () => {
    let now = 1000;
    const store = new InMemorySessionStore({ clock: () => now, pendingTtlMs: 500 });
    await store.putPendingLogin(pending('s1', now));
    now = 2000; // beyond the 500ms TTL
    expect(await store.takePendingLogin('s1')).toBeNull();
  });

  it('revoke marks a session revoked (idempotent) and isRevoked reflects it', async () => {
    const store = new InMemorySessionStore();
    expect(await store.isRevoked('sess-1')).toBe(false);
    await store.revoke('sess-1');
    await store.revoke('sess-1');
    expect(await store.isRevoked('sess-1')).toBe(true);
  });
});
