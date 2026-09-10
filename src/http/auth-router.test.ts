import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { AuthService } from '../services/auth-service.js';
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js';
import { JoseTokenSigner } from '../adapters/jose-token-signer.js';
import { DEFAULT_COOKIE_OPTIONS } from '../config/session-policy.js';
import type { OidcClientPort, ValidatedClaims } from '../ports/oidc-client.js';

/**
 * Integration test for the auth HTTP boundary (auth-router + middleware),
 * covering the login->callback->me->logout flow for story-sso-login and the
 * fail-closed 401 on unauthenticated access. Uses a fake OIDC client so no
 * external IdP is required.
 */

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'vra-app';

class ScriptedOidcClient implements OidcClientPort {
  readonly issuer = ISSUER;
  readonly clientId = CLIENT_ID;
  lastNonce = '';

  buildAuthorizationUrl(req: { state: string; nonce: string; codeVerifier: string }): string {
    this.lastNonce = req.nonce;
    return `${ISSUER}/authorize?state=${req.state}`;
  }

  async exchangeCode(params: { expectedNonce: string }): Promise<ValidatedClaims> {
    return {
      sub: 'user-777',
      iss: ISSUER,
      aud: CLIENT_ID,
      nonce: params.expectedNonce,
      exp: Math.floor(Date.now() / 1000) + 3600,
      claims: { role: 'employee', department: 'sales', email: 'x@example.com' },
    };
  }
}

// Use a non-secure cookie in tests so fetch retains it over http.
const TEST_COOKIE = { ...DEFAULT_COOKIE_OPTIONS, secure: false, name: 'vra_session' };

describe('auth HTTP integration', () => {
  let server: Server;
  let baseUrl: string;
  let oidc: ScriptedOidcClient;
  let service: AuthService;

  beforeAll(async () => {
    oidc = new ScriptedOidcClient();
    service = new AuthService({
      oidc,
      store: new InMemorySessionStore(),
      signer: new JoseTokenSigner({
        signingKey: new TextEncoder().encode('integration-test-signing-key-32bytes!!'),
      }),
    });
    const app = createApp({ service, cookieOptions: TEST_COOKIE });
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /auth/login redirects to the IdP and sets security headers', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(`${ISSUER}/authorize`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('GET /auth/me without a session fails closed with 401', async () => {
    const res = await fetch(`${baseUrl}/auth/me`);
    expect(res.status).toBe(401);
  });

  it('completes the login flow end-to-end and guards /auth/me', async () => {
    // 1. begin login to obtain a valid state (server persists it).
    const begin = await service.beginLogin('/');
    expect(begin.ok).toBe(true);
    if (!begin.ok) return;

    // 2. callback with the issued state (x-forwarded-proto marks it TLS).
    const cbRes = await fetch(
      `${baseUrl}/auth/callback?code=abc&state=${encodeURIComponent(begin.value.state)}`,
      { headers: { 'x-forwarded-proto': 'https' } },
    );
    expect(cbRes.status).toBe(200);
    const setCookie = cbRes.headers.get('set-cookie');
    expect(setCookie).toContain('vra_session=');

    const cookie = (setCookie ?? '').split(';')[0];

    // 3. authenticated /auth/me returns the principal.
    const meRes = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } });
    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as { principalId: string };
    expect(body.principalId).toBe('user-777');

    // 4. logout revokes; a repeated /auth/me is rejected.
    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(logoutRes.status).toBe(204);

    const afterLogout = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } });
    expect(afterLogout.status).toBe(401);
  });

  it('rejects a callback with an unknown state (fail closed 401)', async () => {
    const res = await fetch(
      `${baseUrl}/auth/callback?code=abc&state=never-issued`,
      { headers: { 'x-forwarded-proto': 'https' } },
    );
    expect(res.status).toBe(401);
  });
});
