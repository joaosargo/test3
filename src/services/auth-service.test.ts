import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthService } from './auth-service.js';
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js';
import type { OidcClientPort, ValidatedClaims } from '../ports/oidc-client.js';
import type { TokenSigner, SessionTokenClaims } from '../ports/token-signer.js';
import type { SsoCallback } from '../domain/entities.js';

/**
 * Unit tests for the AuthService — the ordered fail-closed validation
 * (security-design) and the beginLogin/completeLogin/endSession contract
 * (business-logic-model). One negative test per validation check + happy path,
 * per the security-design verification approach.
 */

const CLIENT_ID = 'vra-app';
const ISSUER = 'https://idp.example.com';
const FIXED_NOW = 1_700_000_000_000; // fixed clock for determinism

/** Configurable fake OIDC client capturing the state/nonce it was given. */
class FakeOidcClient implements OidcClientPort {
  readonly issuer = ISSUER;
  readonly clientId = CLIENT_ID;
  lastState = '';
  lastNonce = '';
  lastVerifier = '';
  claimsToReturn: ValidatedClaims | null = null;
  exchangeError: Error | null = null;

  buildAuthorizationUrl(req: { state: string; nonce: string; codeVerifier: string }): string {
    this.lastState = req.state;
    this.lastNonce = req.nonce;
    this.lastVerifier = req.codeVerifier;
    return `${ISSUER}/authorize?state=${req.state}`;
  }

  async exchangeCode(params: { expectedNonce: string }): Promise<ValidatedClaims> {
    if (this.exchangeError) throw this.exchangeError;
    if (!this.claimsToReturn) throw new Error('no claims configured');
    // Echo the nonce the service expects unless a test overrides it.
    return { ...this.claimsToReturn, nonce: this.claimsToReturn.nonce ?? params.expectedNonce };
  }
}

/** Trivial signer for asserting establishSession output shape. */
class FakeSigner implements TokenSigner {
  signed: SessionTokenClaims | null = null;
  async sign(claims: SessionTokenClaims): Promise<string> {
    this.signed = claims;
    return `signed.${claims.sid}`;
  }
  async verify(token: string): Promise<SessionTokenClaims> {
    if (!this.signed || token !== `signed.${this.signed.sid}`) {
      throw new Error('invalid token');
    }
    return this.signed;
  }
}

function baseClaims(overrides: Partial<ValidatedClaims> = {}): ValidatedClaims {
  return {
    sub: 'user-123',
    iss: ISSUER,
    aud: CLIENT_ID,
    nonce: undefined, // will echo expected nonce by default
    exp: Math.floor(FIXED_NOW / 1000) + 3600,
    claims: { role: 'employee', department: 'eng', email: 'e@example.com' },
    ...overrides,
  };
}

describe('AuthService.beginLogin', () => {
  let oidc: FakeOidcClient;
  let store: InMemorySessionStore;
  let service: AuthService;

  beforeEach(() => {
    oidc = new FakeOidcClient();
    store = new InMemorySessionStore({ clock: () => FIXED_NOW });
    service = new AuthService({
      oidc,
      store,
      signer: new FakeSigner(),
      clock: () => FIXED_NOW,
    });
  });

  it('returns a redirect descriptor with single-use state and nonce (happy path)', async () => {
    const result = await service.beginLogin('/dashboard');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authorizationUrl).toContain(`${ISSUER}/authorize`);
    expect(result.value.state).toBe(oidc.lastState);
    expect(result.value.nonce).toBe(oidc.lastNonce);
    expect(result.value.state).not.toEqual(result.value.nonce);
  });

  it('surfaces CONFIG_ERROR (never a credential prompt) when the IdP is misconfigured', async () => {
    oidc.buildAuthorizationUrl = () => {
      throw new Error('metadata missing');
    };
    const result = await service.beginLogin('/');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG_ERROR');
  });
});

describe('AuthService.completeLogin — ordered fail-closed validation', () => {
  let oidc: FakeOidcClient;
  let store: InMemorySessionStore;
  let service: AuthService;

  beforeEach(() => {
    oidc = new FakeOidcClient();
    store = new InMemorySessionStore({ clock: () => FIXED_NOW });
    service = new AuthService({
      oidc,
      store,
      signer: new FakeSigner(),
      clock: () => FIXED_NOW,
      clockSkewSeconds: 60,
    });
  });

  /** Drive beginLogin, then return a valid callback for the persisted state. */
  async function primeLogin(): Promise<SsoCallback> {
    const begin = await service.beginLogin('/');
    if (!begin.ok) throw new Error('begin failed');
    return { code: 'auth-code', state: begin.value.state, overTls: true };
  }

  it('check 1 — rejects a non-TLS callback with TRANSPORT_INSECURE', async () => {
    const cb = await primeLogin();
    const result = await service.completeLogin({ ...cb, overTls: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TRANSPORT_INSECURE');
  });

  it('rejects a malformed callback (missing code) with MALFORMED_ASSERTION', async () => {
    const cb = await primeLogin();
    const result = await service.completeLogin({ ...cb, code: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MALFORMED_ASSERTION');
  });

  it('check 2 — rejects an unknown/replayed state with STATE_MISMATCH', async () => {
    await primeLogin();
    const result = await service.completeLogin({
      code: 'auth-code',
      state: 'never-issued',
      overTls: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STATE_MISMATCH');
  });

  it('check 2 — state is single-use (second use fails STATE_MISMATCH)', async () => {
    const cb = await primeLogin();
    oidc.claimsToReturn = baseClaims({ nonce: oidc.lastNonce });
    const first = await service.completeLogin(cb);
    expect(first.ok).toBe(true);
    const second = await service.completeLogin(cb);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('STATE_MISMATCH');
  });

  it('check 3 — rejects a nonce mismatch with NONCE_REPLAY', async () => {
    const cb = await primeLogin();
    oidc.claimsToReturn = baseClaims({ nonce: 'a-different-nonce' });
    const result = await service.completeLogin(cb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NONCE_REPLAY');
  });

  it('check 4 — maps signature verification failure to SIGNATURE_INVALID', async () => {
    const cb = await primeLogin();
    const sigErr = new Error('signature check failed');
    sigErr.name = 'JWSSignatureVerificationFailed';
    oidc.exchangeError = sigErr;
    const result = await service.completeLogin(cb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SIGNATURE_INVALID');
  });

  it('check 5 — rejects a foreign issuer with ISSUER_MISMATCH', async () => {
    const cb = await primeLogin();
    oidc.claimsToReturn = baseClaims({ nonce: oidc.lastNonce, iss: 'https://evil.example' });
    const result = await service.completeLogin(cb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ISSUER_MISMATCH');
  });

  it('check 6 — rejects a wrong audience with AUDIENCE_MISMATCH', async () => {
    const cb = await primeLogin();
    oidc.claimsToReturn = baseClaims({ nonce: oidc.lastNonce, aud: 'some-other-client' });
    const result = await service.completeLogin(cb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUDIENCE_MISMATCH');
  });

  it('check 7 — rejects an expired token (beyond clock skew) with TOKEN_EXPIRED', async () => {
    const cb = await primeLogin();
    oidc.claimsToReturn = baseClaims({
      nonce: oidc.lastNonce,
      exp: Math.floor(FIXED_NOW / 1000) - 120,
    });
    const result = await service.completeLogin(cb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TOKEN_EXPIRED');
  });

  it('check 8 — rejects a missing subject with SUBJECT_MISSING', async () => {
    const cb = await primeLogin();
    oidc.claimsToReturn = baseClaims({ nonce: oidc.lastNonce, sub: '' });
    const result = await service.completeLogin(cb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SUBJECT_MISSING');
  });

  it('maps a network exchange failure to IDP_UNAVAILABLE (no local fallback)', async () => {
    const cb = await primeLogin();
    oidc.exchangeError = new Error('network timeout contacting idp');
    const result = await service.completeLogin(cb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IDP_UNAVAILABLE');
  });

  it('happy path — all checks pass and forwards raw claims uninterpreted', async () => {
    const cb = await primeLogin();
    oidc.claimsToReturn = baseClaims({ nonce: oidc.lastNonce });
    const result = await service.completeLogin(cb);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.principalId).toBe('user-123');
    // Role/department are forwarded, NOT resolved into an app role here.
    expect(result.value.rawClaims.role).toBe('employee');
    expect(result.value.rawClaims.department).toBe('eng');
  });
});

describe('AuthService session lifecycle', () => {
  let oidc: FakeOidcClient;
  let store: InMemorySessionStore;
  let signer: FakeSigner;
  let service: AuthService;

  beforeEach(() => {
    oidc = new FakeOidcClient();
    store = new InMemorySessionStore({ clock: () => FIXED_NOW });
    signer = new FakeSigner();
    service = new AuthService({ oidc, store, signer, clock: () => FIXED_NOW });
  });

  it('establishSession mints a fresh session id and stateless token', async () => {
    const { session, token } = await service.establishSession({
      principalId: 'user-123',
      rawClaims: {},
    });
    expect(session.sessionId).toBeTruthy();
    expect(session.principalRef).toBe('user-123');
    expect(token).toBe(`signed.${session.sessionId}`);
    expect(session.absoluteExpiryAt).toBeGreaterThan(session.createdAt);
  });

  it('validateSession accepts a fresh token (happy path)', async () => {
    const { token } = await service.establishSession({ principalId: 'u1', rawClaims: {} });
    const result = await service.validateSession(token);
    expect(result.ok).toBe(true);
  });

  it('validateSession fails closed (SESSION_NOT_FOUND) on a forged token', async () => {
    const result = await service.validateSession('forged.token');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('endSession revokes the session so subsequent validation fails closed', async () => {
    const { session, token } = await service.establishSession({ principalId: 'u1', rawClaims: {} });
    await service.endSession(session.sessionId);
    const result = await service.validateSession(token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('endSession is idempotent', async () => {
    const { session } = await service.establishSession({ principalId: 'u1', rawClaims: {} });
    await service.endSession(session.sessionId);
    await expect(service.endSession(session.sessionId)).resolves.toBeUndefined();
  });

  it('validateSession fails closed when the revocation lookup itself errors', async () => {
    const { token } = await service.establishSession({ principalId: 'u1', rawClaims: {} });
    vi.spyOn(store, 'isRevoked').mockRejectedValueOnce(new Error('store down'));
    const result = await service.validateSession(token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('shouldSlideIdleWindow honors the throttle window', () => {
    const base = {
      sessionId: 's1',
      principalRef: 'u1',
      createdAt: FIXED_NOW,
      lastSeenAt: FIXED_NOW,
      absoluteExpiryAt: FIXED_NOW + 1000,
    };
    // Just seen -> no slide.
    expect(service.shouldSlideIdleWindow(base)).toBe(false);
    // Seen 61s ago -> slide due.
    const stale = { ...base, lastSeenAt: FIXED_NOW - 61_000 };
    expect(service.shouldSlideIdleWindow(stale)).toBe(true);
  });
});
