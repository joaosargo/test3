/**
 * Domain entities & value objects for unit-platform-auth.
 *
 * Grounded in domain-entities (SSO Domain Entities & Value Objects) and the
 * `claims_to_principal_transformation` block of business-logic-model. The
 * adapter derives a stable principal from validated IdP claims and forwards
 * raw role/department claims WITHOUT interpreting them — role resolution is
 * owned by unit-platform-authz (downstream, read-only here).
 */

/** Stable subject identifier from the IdP (`sub` / SAML `NameID`). */
export type PrincipalId = string;

/** Opaque server-side session identifier. */
export type SessionId = string;

/**
 * Raw role/department claims forwarded to authorization-rbac. This unit does
 * NOT resolve Employee/Team Lead/HR roles from these values.
 */
export interface RawClaims {
  readonly role?: string | readonly string[];
  readonly department?: string;
  /** Subject email/upn — PII; forwarded but never logged. */
  readonly email?: string;
}

/**
 * The authenticated identity handed across the auth boundary. Guaranteed
 * genuine and untampered by the ordered validation in `completeLogin`.
 */
export interface AuthenticatedPrincipal {
  readonly principalId: PrincipalId;
  readonly rawClaims: RawClaims;
}

/**
 * Application session. Stateless-signed token strategy (performance-design
 * ADR): the token itself carries identity + expiry; the store holds only
 * revocation markers and login state/nonce.
 */
export interface Session {
  readonly sessionId: SessionId;
  readonly principalRef: PrincipalId;
  /** Epoch ms when the session was minted. */
  readonly createdAt: number;
  /** Epoch ms of the last activity slide (idle window). */
  readonly lastSeenAt: number;
  /** Epoch ms absolute expiry (createdAt + absolute TTL). */
  readonly absoluteExpiryAt: number;
}

/** Descriptor returned by `beginLogin` to drive the browser redirect to the IdP. */
export interface RedirectDescriptor {
  /** Fully-formed IdP authorization URL (OIDC authorization endpoint). */
  readonly authorizationUrl: string;
  /** Single-use CSRF state persisted bound to the pending login. */
  readonly state: string;
  /** Single-use OIDC nonce persisted bound to the pending login. */
  readonly nonce: string;
  /** PKCE code verifier persisted bound to the pending login. */
  readonly codeVerifier: string;
}

/** Inbound callback payload from the IdP (OIDC authorization-code flow). */
export interface SsoCallback {
  /** Authorization code returned by the IdP. */
  readonly code: string;
  /** State echoed back by the IdP; validated against the persisted value. */
  readonly state: string;
  /** True only if the callback arrived over TLS (check 1). */
  readonly overTls: boolean;
}

/** Pending-login record persisted at `beginLogin`, consumed at `completeLogin`. */
export interface PendingLogin {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnUrl: string;
  readonly createdAt: number;
}
