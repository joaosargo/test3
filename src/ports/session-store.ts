import type { PendingLogin, SessionId } from '../domain/entities.js';

/**
 * SessionStore port — the shared, low-latency store (Redis-class in
 * production per tech-stack-decisions ADR-AUTH-03) that holds single-use
 * login state/nonce and session-revocation markers.
 *
 * The hot session-validation path (performance-design) does NOT read this
 * store for identity — the stateless signed token carries that. The store is
 * consulted only for (a) login state/nonce during `completeLogin`, and (b)
 * revocation correctness (SEC-SES-4). Reads fail closed
 * (reliability-requirements REL-STORE-2): if revocation state cannot be
 * determined, treat the session as revoked.
 */
export interface SessionStore {
  /** Persist a pending login keyed by its single-use state. */
  putPendingLogin(login: PendingLogin): Promise<void>;

  /**
   * Atomically fetch and delete the pending login for a state (single-use).
   * Returns null if absent or already consumed (replay).
   */
  takePendingLogin(state: string): Promise<PendingLogin | null>;

  /** Mark a session revoked (logout). Idempotent. */
  revoke(sessionId: SessionId): Promise<void>;

  /** True if the session has been revoked. Fails closed on lookup error. */
  isRevoked(sessionId: SessionId): Promise<boolean>;
}
