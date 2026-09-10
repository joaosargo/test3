/**
 * Session & security policy configuration for unit-platform-auth.
 *
 * Defaults mirror security-design (`session_timeouts`, `session_cookie`) and
 * the "assumptions to confirm" flagged upstream. Values are injected, never
 * hard-coded secrets (ADR-AUTH-04) — secrets themselves arrive via the
 * TokenSigner / OidcClientPort adapters.
 */
export interface SessionPolicy {
  /** Idle timeout in minutes (security-design default 30). */
  readonly idleTimeoutMinutes: number;
  /** Absolute session TTL in hours (security-design default 8). */
  readonly absoluteTtlHours: number;
  /**
   * Minimum seconds between idle-window slide writes (performance-design:
   * throttle to at most one write per 60s per session).
   */
  readonly idleSlideThrottleSeconds: number;
}

export interface CookieOptions {
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: 'Lax' | 'Strict';
  readonly name: string;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleTimeoutMinutes: 30,
  absoluteTtlHours: 8,
  idleSlideThrottleSeconds: 60,
};

/**
 * Session cookie attributes (security-design `session_cookie`): Secure,
 * HttpOnly, SameSite=Lax, never exposed to JavaScript, never in a URL.
 */
export const DEFAULT_COOKIE_OPTIONS: CookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
  name: '__Host-vra_session',
};
