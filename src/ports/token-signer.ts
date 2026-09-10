/**
 * TokenSigner port — signs/verifies the stateless session token.
 *
 * Per performance-design ADR ("In-Process Stateless Validation over Central
 * Session Lookup") and security-design (`token: stateless_signed_or_encrypted,
 * forgeable: false`), the session token carries identity + expiry and is
 * verified in-process on the hot path with NO store round-trip. Signing keys
 * live in a managed secret manager (ADR-AUTH-04), injected at construction —
 * never hard-coded.
 */
export interface SessionTokenClaims {
  /** Session id (opaque). */
  readonly sid: string;
  /** Principal reference. */
  readonly sub: string;
  /** Issued-at (epoch seconds). */
  readonly iat: number;
  /** Absolute expiry (epoch seconds). */
  readonly exp: number;
  /** Last-seen slide marker (epoch seconds) for the idle window. */
  readonly lsa: number;
}

export interface TokenSigner {
  /** Sign session claims into a compact, tamper-evident token. */
  sign(claims: SessionTokenClaims): Promise<string>;

  /**
   * Verify and decode a session token. Rejects (throws) forged, tampered, or
   * expired tokens — the caller maps failure to SESSION_NOT_FOUND.
   */
  verify(token: string): Promise<SessionTokenClaims>;
}
