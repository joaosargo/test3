import type { PrincipalId, RawClaims } from '../domain/entities.js';

/**
 * Validated claims produced by the certified OIDC library after the callback
 * exchange. The OidcClientPort wraps the certified library (ADR-AUTH-01) so
 * the domain never sees raw protocol shapes (Adapter/Port anti-corruption
 * boundary, business-logic-model `posture.isolation`).
 */
export interface ValidatedClaims {
  /** Stable subject identifier (`sub`). */
  readonly sub: PrincipalId;
  /** Issuer (`iss`) as asserted by the token. */
  readonly iss: string;
  /** Audience (`aud`) as asserted by the token. */
  readonly aud: string | readonly string[];
  /** Nonce echoed in the ID token. */
  readonly nonce?: string;
  /** Expiry (epoch seconds). */
  readonly exp: number;
  /** Not-before (epoch seconds), optional. */
  readonly nbf?: number;
  /** Forwarded role/department/email claims (uninterpreted). */
  readonly claims: RawClaims;
}

/** Parameters needed to build an authorization redirect. */
export interface AuthorizationRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

/**
 * OidcClientPort — anti-corruption wrapper around the certified OIDC/OAuth2
 * library (openid-client). Signature verification uses cached JWKS
 * (performance-design: in-process, never a synchronous network fetch on the
 * hot path). Hand-rolled crypto/parsing is forbidden (ADR-AUTH-01).
 *
 * The port throws on transport/protocol failures (mapped by the caller to
 * IDP_UNAVAILABLE / SIGNATURE_INVALID / MALFORMED_ASSERTION SsoErrors) — there
 * is no local credential fallback on any branch.
 */
export interface OidcClientPort {
  /** The configured trusted issuer, for the issuer check (check 5). */
  readonly issuer: string;
  /** The registered client id, for the audience check (check 6). */
  readonly clientId: string;

  /** Build the IdP authorization URL (PKCE + state + nonce). */
  buildAuthorizationUrl(req: AuthorizationRequest): string;

  /**
   * Exchange the authorization code and return signature-verified,
   * schema-valid claims. Throws on network/signature/parse failure.
   */
  exchangeCode(params: {
    code: string;
    codeVerifier: string;
    expectedNonce: string;
  }): Promise<ValidatedClaims>;
}
