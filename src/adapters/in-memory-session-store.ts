import type { PendingLogin, SessionId } from '../domain/entities.js';
import type { SessionStore } from '../ports/session-store.js';

interface StoredPending extends PendingLogin {
  expiresAt: number;
}

/**
 * In-memory SessionStore for the walking skeleton and tests.
 *
 * Production wires a Redis-class shared cache here (tech-stack-decisions
 * ADR-AUTH-03) so any stateless node can validate any session; the port
 * boundary keeps that swap invisible to AuthService. TTLs mirror the nonce
 * replay window / absolute session TTL.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly pending = new Map<string, StoredPending>();
  private readonly revoked = new Set<SessionId>();
  private readonly now: () => number;
  private readonly pendingTtlMs: number;

  constructor(opts: { clock?: () => number; pendingTtlMs?: number } = {}) {
    this.now = opts.clock ?? Date.now;
    this.pendingTtlMs = opts.pendingTtlMs ?? 10 * 60 * 1000; // 10 min login window
  }

  async putPendingLogin(login: PendingLogin): Promise<void> {
    this.pending.set(login.state, { ...login, expiresAt: this.now() + this.pendingTtlMs });
  }

  async takePendingLogin(state: string): Promise<PendingLogin | null> {
    const entry = this.pending.get(state);
    if (entry === undefined) return null;
    // Single-use: delete on read to defeat replay.
    this.pending.delete(state);
    if (entry.expiresAt <= this.now()) return null;
    return {
      state: entry.state,
      nonce: entry.nonce,
      codeVerifier: entry.codeVerifier,
      returnUrl: entry.returnUrl,
      createdAt: entry.createdAt,
    };
  }

  async revoke(sessionId: SessionId): Promise<void> {
    this.revoked.add(sessionId);
  }

  async isRevoked(sessionId: SessionId): Promise<boolean> {
    return this.revoked.has(sessionId);
  }
}
