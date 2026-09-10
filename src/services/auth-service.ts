import type {
  AuthenticatedPrincipal,
  RedirectDescriptor,
  Session,
  SessionId,
  SsoCallback,
} from '../domain/entities.js';
import { type Result, ok, err } from '../domain/result.js';
import { SsoError } from '../domain/sso-error.js';
import type { OidcClientPort, ValidatedClaims } from '../ports/oidc-client.js';
import type { SessionStore } from '../ports/session-store.js';
import type { TokenSigner } from '../ports/token-signer.js';
import {
  type SessionPolicy,
  DEFAULT_SESSION_POLICY,
} from '../config/session-policy.js';
import {
  generateOpaqueToken,
  generateSessionId,
  generateCodeVerifier,
} from '../domain/crypto.js';

/** Optional audit sink — auth events go to unit-audit-trail (out of unit). */
export interface AuthEventSink {
  record(event: {
    type:
      | 'LOGIN_SUCCEEDED'
      | 'LOGIN_FAILED'
      | 'LOGOUT'
      | 'SESSION_VALIDATION_FAILED';
    principalId?: string;
    sessionId?: string;
    reason?: string;
    at: number;
  }): void;
}

export interface AuthServiceDeps {
  readonly oidc: OidcClientPort;
  readonly store: SessionStore;
  readonly signer: TokenSigner;
  readonly policy?: SessionPolicy;
  readonly clock?: () => number;
  readonly audit?: AuthEventSink;
  /** Allowed clock skew for token timestamp checks (seconds, default 60). */
  readonly clockSkewSeconds?: number;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Identity & Access Service orchestration for unit-platform-auth.
 *
 * Realizes the `beginLogin` / `completeLogin` / `endSession` contract
 * (business-logic-model, story-sso-login) satisfying req-sso-authentication
 * and req-constraint-sso-mandatory. It is strictly an Adapter/Port around the
 * corporate IdP: no in-house credential path exists on ANY branch, and the
 * ordered fail-closed validation (security-design) is enforced here, not in
 * the transport library.
 */
export class AuthService {
  private readonly oidc: OidcClientPort;
  private readonly store: SessionStore;
  private readonly signer: TokenSigner;
  private readonly policy: SessionPolicy;
  private readonly now: () => number;
  private readonly audit?: AuthEventSink;
  private readonly clockSkewSeconds: number;

  constructor(deps: AuthServiceDeps) {
    this.oidc = deps.oidc;
    this.store = deps.store;
    this.signer = deps.signer;
    this.policy = deps.policy ?? DEFAULT_SESSION_POLICY;
    this.now = deps.clock ?? Date.now;
    this.audit = deps.audit;
    this.clockSkewSeconds = deps.clockSkewSeconds ?? 60;
  }

  /**
   * Step "begin": generate single-use state + nonce + PKCE verifier, persist
   * them bound to the pending login, and return the IdP authorization
   * redirect. Never renders a credential prompt (req-constraint-sso-mandatory).
   */
  async beginLogin(returnUrl: string): Promise<Result<RedirectDescriptor, SsoError>> {
    const state = generateOpaqueToken();
    const nonce = generateOpaqueToken();
    const codeVerifier = generateCodeVerifier();
    const createdAt = this.now();

    let authorizationUrl: string;
    try {
      authorizationUrl = this.oidc.buildAuthorizationUrl({ state, nonce, codeVerifier });
    } catch {
      // Misconfigured IdP metadata/client — surface config error, never a prompt.
      return err(SsoError.of('CONFIG_ERROR', 'SSO is not correctly configured.'));
    }

    await this.store.putPendingLogin({ state, nonce, codeVerifier, returnUrl, createdAt });

    return ok({ authorizationUrl, state, nonce, codeVerifier });
  }

  /**
   * Step "callback" + "validate-assertion" + "establish-session".
   * Runs the eight ordered fail-closed checks (security-design). On any
   * failure returns Err(SsoError) => access denied, no session, no prompt.
   */
  async completeLogin(callback: SsoCallback): Promise<Result<AuthenticatedPrincipal, SsoError>> {
    // Check 1 — Transport: callback must arrive over TLS.
    if (!callback.overTls) {
      return this.deny('TRANSPORT_INSECURE', 'Callback must be received over TLS.');
    }

    // Reject malformed input before any expensive processing.
    if (!callback.code || !callback.state) {
      return this.deny('MALFORMED_ASSERTION', 'Malformed callback payload.');
    }

    // Check 2 — State/CSRF: consume the single-use pending login by state.
    const pending = await this.store.takePendingLogin(callback.state);
    if (pending === null || pending.state !== callback.state) {
      return this.deny('STATE_MISMATCH', 'Login state did not match.');
    }

    // Exchange the code via the certified library (signature check 4 happens here).
    let claims: ValidatedClaims;
    try {
      claims = await this.oidc.exchangeCode({
        code: callback.code,
        codeVerifier: pending.codeVerifier,
        expectedNonce: pending.nonce,
      });
    } catch (cause) {
      const code = classifyExchangeFailure(cause);
      return this.deny(code, 'Assertion could not be validated.');
    }

    // Check 3 — Nonce/replay: nonce in token must match the persisted nonce.
    if (!claims.nonce || claims.nonce !== pending.nonce) {
      return this.deny('NONCE_REPLAY', 'Login nonce did not match.');
    }

    // Check 5 — Issuer.
    if (claims.iss !== this.oidc.issuer) {
      return this.deny('ISSUER_MISMATCH', 'Token issuer is not trusted.');
    }

    // Check 6 — Audience.
    if (!audienceMatches(claims.aud, this.oidc.clientId)) {
      return this.deny('AUDIENCE_MISMATCH', 'Token audience is not this application.');
    }

    // Check 7 — Timestamp with bounded clock skew.
    const nowSec = Math.floor(this.now() / SECOND_MS);
    if (claims.exp + this.clockSkewSeconds <= nowSec) {
      return this.deny('TOKEN_EXPIRED', 'Token has expired.');
    }
    if (claims.nbf !== undefined && claims.nbf - this.clockSkewSeconds > nowSec) {
      return this.deny('TOKEN_EXPIRED', 'Token is not yet valid.');
    }

    // Check 8 — Subject present.
    if (!claims.sub) {
      return this.deny('SUBJECT_MISSING', 'Token has no stable subject.');
    }

    // Success: derive principal, forwarding raw claims uninterpreted.
    const principal: AuthenticatedPrincipal = {
      principalId: claims.sub,
      rawClaims: claims.claims,
    };

    this.audit?.record({
      type: 'LOGIN_SUCCEEDED',
      principalId: principal.principalId,
      at: this.now(),
    });

    return ok(principal);
  }

  /**
   * Mint a stateless signed session token for a validated principal. Session
   * id is fresh (rotation after login, SEC-SES-3) so fixation is impossible.
   */
  async establishSession(principal: AuthenticatedPrincipal): Promise<{ session: Session; token: string }> {
    const nowMs = this.now();
    const sessionId = generateSessionId();
    const absoluteExpiryAt = nowMs + this.policy.absoluteTtlHours * HOUR_MS;

    const session: Session = {
      sessionId,
      principalRef: principal.principalId,
      createdAt: nowMs,
      lastSeenAt: nowMs,
      absoluteExpiryAt,
    };

    const token = await this.signer.sign({
      sid: sessionId,
      sub: principal.principalId,
      iat: Math.floor(nowMs / SECOND_MS),
      exp: Math.floor(absoluteExpiryAt / SECOND_MS),
      lsa: Math.floor(nowMs / SECOND_MS),
    });

    return { session, token };
  }

  /**
   * Step "logout": terminate the application session server-side. Idempotent
   * (SEC-SES-4). IdP single-logout propagation is a best-effort concern of the
   * transport adapter and is intentionally not coupled to this call.
   */
  async endSession(sessionId: SessionId): Promise<void> {
    await this.store.revoke(sessionId);
    this.audit?.record({ type: 'LOGOUT', sessionId, at: this.now() });
  }

  /**
   * Per-request session validation — the performance-critical hot path
   * (performance-design: <=5ms p95). Verifies the stateless token in-process,
   * checks the idle + absolute windows, then consults the revocation cache
   * ONLY for correctness. Fails closed (returns SESSION_NOT_FOUND) on any
   * error, including revocation-lookup failure (REL-STORE-2).
   */
  async validateSession(token: string): Promise<Result<Session, SsoError>> {
    let claims;
    try {
      claims = await this.signer.verify(token);
    } catch {
      return this.denyValidation('Session token is invalid.');
    }

    const nowSec = Math.floor(this.now() / SECOND_MS);

    // Absolute expiry.
    if (claims.exp <= nowSec) {
      return this.denyValidation('Session has expired.');
    }

    // Idle window: last-seen + idle timeout.
    const idleDeadline = claims.lsa + this.policy.idleTimeoutMinutes * 60;
    if (idleDeadline <= nowSec) {
      return this.denyValidation('Session is idle-expired.');
    }

    // Revocation — fail closed if the lookup itself fails.
    let revoked: boolean;
    try {
      revoked = await this.store.isRevoked(claims.sid);
    } catch {
      return this.denyValidation('Session revocation state is unavailable.');
    }
    if (revoked) {
      return this.denyValidation('Session has been revoked.');
    }

    const session: Session = {
      sessionId: claims.sid,
      principalRef: claims.sub,
      createdAt: claims.iat * SECOND_MS,
      lastSeenAt: claims.lsa * SECOND_MS,
      absoluteExpiryAt: claims.exp * SECOND_MS,
    };
    return ok(session);
  }

  /**
   * Decide whether an idle-window slide write is due, honoring the throttle
   * (performance-design: <=1 write / 60s / session). Pure decision — the
   * caller re-signs/re-issues the cookie when this returns true.
   */
  shouldSlideIdleWindow(session: Session): boolean {
    const elapsedSec = (this.now() - session.lastSeenAt) / SECOND_MS;
    return elapsedSec >= this.policy.idleSlideThrottleSeconds;
  }

  private deny(code: Parameters<typeof SsoError.of>[0], message: string): Result<never, SsoError> {
    this.audit?.record({ type: 'LOGIN_FAILED', reason: code, at: this.now() });
    return err(SsoError.of(code, message));
  }

  private denyValidation(message: string): Result<never, SsoError> {
    this.audit?.record({ type: 'SESSION_VALIDATION_FAILED', at: this.now() });
    return err(SsoError.of('SESSION_NOT_FOUND', message));
  }
}

/** Audience check: aud may be a string or array; must contain the client id. */
function audienceMatches(aud: string | readonly string[], clientId: string): boolean {
  return Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
}

/** Map a certified-library exchange failure to an SsoError code. */
function classifyExchangeFailure(cause: unknown): Parameters<typeof SsoError.of>[0] {
  const name = cause instanceof Error ? cause.name : '';
  const message = cause instanceof Error ? cause.message.toLowerCase() : '';
  if (name === 'JWSSignatureVerificationFailed' || message.includes('signature')) {
    return 'SIGNATURE_INVALID';
  }
  if (message.includes('network') || message.includes('timeout') || message.includes('econn')) {
    return 'IDP_UNAVAILABLE';
  }
  return 'MALFORMED_ASSERTION';
}
