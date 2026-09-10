import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { AuthService } from '../../services/auth-service.js';
import { InMemorySessionStore } from '../../adapters/in-memory-session-store.js';
import { JoseTokenSigner } from '../../adapters/jose-token-signer.js';
import { DEFAULT_COOKIE_OPTIONS } from '../../config/session-policy.js';
import type { OidcClientPort, ValidatedClaims } from '../../ports/oidc-client.js';
import { buildAuthRouter } from '../../http/auth-router.js';
import { createBalanceService, mountBalanceRoutes } from '../hris-balance.js';
import { StubHrisClient } from '../adapters/stub-hris-client.js';
import type { RawHrisBalance } from '../ports/hris-client.js';

/**
 * Integration test for the display-only balance HTTP boundary
 * (story-display-balance). Reuses the unit-platform-auth AuthService so the
 * /me/leave-balance route is guarded by a real session; a scripted OIDC
 * client mints the identity without a live IdP.
 */

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'vra-app';
const SUBJECT = 'user-777';

class ScriptedOidcClient implements OidcClientPort {
  readonly issuer = ISSUER;
  readonly clientId = CLIENT_ID;

  buildAuthorizationUrl(req: { state: string; nonce: string; codeVerifier: string }): string {
    return `${ISSUER}/authorize?state=${req.state}`;
  }

  async exchangeCode(params: { expectedNonce: string }): Promise<ValidatedClaims> {
    return {
      sub: SUBJECT,
      iss: ISSUER,
      aud: CLIENT_ID,
      nonce: params.expectedNonce,
      exp: Math.floor(Date.now() / 1000) + 3600,
      claims: { role: 'employee', department: 'sales', email: 'x@example.com' },
    };
  }
}

const TEST_COOKIE = { ...DEFAULT_COOKIE_OPTIONS, secure: false, name: 'vra_session' };

const SEED: Record<string, RawHrisBalance> = {
  [SUBJECT]: { employeeId: SUBJECT, accrued: 25, used: 10, remaining: 15, asOf: Date.now() },
};

async function authenticatedCookie(baseUrl: string, service: AuthService): Promise<string> {
  const begin = await service.beginLogin('/');
  if (!begin.ok) throw new Error('beginLogin failed');
  const cbRes = await fetch(
    `${baseUrl}/auth/callback?code=abc&state=${encodeURIComponent(begin.value.state)}`,
    { headers: { 'x-forwarded-proto': 'https' } },
  );
  const setCookie = cbRes.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0];
}

function buildAppWithAuth(service: AuthService, hris: StubHrisClient): Express {
  const app = express();
  app.disable('x-powered-by');
  // Minimal auth surface needed to mint a session for the test.
  app.use(buildAuthRouter({ service, cookieOptions: TEST_COOKIE }));
  const balanceService = createBalanceService({ hris });
  mountBalanceRoutes(app, {
    balanceService,
    authService: service,
    cookieOptions: TEST_COOKIE,
  });
  return app;
}

describe('display-only balance HTTP integration', () => {
  let server: Server;
  let baseUrl: string;
  let service: AuthService;

  beforeAll(async () => {
    service = new AuthService({
      oidc: new ScriptedOidcClient(),
      store: new InMemorySessionStore(),
      signer: new JoseTokenSigner({
        signingKey: new TextEncoder().encode('integration-test-signing-key-32bytes!!'),
      }),
    });
    const app = buildAppWithAuth(service, new StubHrisClient({ seed: SEED }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails closed with 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/me/leave-balance`);
    expect(res.status).toBe(401);
  });

  it('returns the authenticated principal own available balance', async () => {
    const cookie = await authenticatedCookie(baseUrl, service);
    const res = await fetch(`${baseUrl}/me/leave-balance`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      status: string;
      balance: { remainingDays: number };
    };
    expect(body.status).toBe('available');
    expect(body.balance.remainingDays).toBe(15);
  });

  it('returns a non-blocking unavailable envelope when HRIS has no record', async () => {
    // Fresh app whose HRIS has no seed -> NOT_FOUND degradation.
    const emptyService = new AuthService({
      oidc: new ScriptedOidcClient(),
      store: new InMemorySessionStore(),
      signer: new JoseTokenSigner({
        signingKey: new TextEncoder().encode('integration-test-signing-key-32bytes!!'),
      }),
    });
    const emptyApp = buildAppWithAuth(emptyService, new StubHrisClient({ seed: {} }));
    const s = emptyApp.listen(0);
    const { port } = s.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    try {
      const cookie = await authenticatedCookie(url, emptyService);
      const res = await fetch(`${url}/me/leave-balance`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; reason: string };
      expect(body.status).toBe('unavailable');
      expect(body.reason).toBe('NOT_FOUND');
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});
