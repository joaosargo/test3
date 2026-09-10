import { randomUUID, randomBytes, createHash } from 'node:crypto';

/**
 * Crypto helpers for single-use login values and PKCE.
 *
 * These generate high-entropy random values only — all assertion parsing,
 * signature verification, and protocol crypto is delegated to the certified
 * OIDC library via OidcClientPort (ADR-AUTH-01: never hand-rolled).
 */

/** Generate a URL-safe, high-entropy single-use value (state / nonce). */
export function generateOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Generate an opaque server-side session id. */
export function generateSessionId(): string {
  return randomUUID();
}

/** PKCE code verifier: 43-128 chars, URL-safe. */
export function generateCodeVerifier(): string {
  return randomBytes(48).toString('base64url');
}

/** PKCE code challenge (S256) derived from the verifier. */
export function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
