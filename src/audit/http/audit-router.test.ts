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
import { AuthzService, InMemoryRoleDirectory } from '../../authz/index.js';
import { createAuditService, mountAuditRoutes } from '../index.js';
import type { AuditService } from '../services/audit-service.js';
import type { WorkflowEvent } from '../../workflow/domain/events.js';

/**
 * Integration test for the audit-trail read boundary (story-immutable-audit).
 * Reuses the real unit-platform-auth AuthService (session) and the real
 * unit-platform-authz AuthzService (RBAC), exactly as the shipped units are
 * composed in production. A scripted OIDC client mints the identity; the role
 * directory decides the caller's role.
 */

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'vra-app';
const SUBJECT = 'auditor-1';
const TEST_COOKIE = { ...DEFAULT_COOKIE_OPTIONS, secure: false, name: 'vra_session' };

class ScriptedOidcClient implements OidcClientPort {
  readonly issuer = ISSUER;
  readonly clientId = CLIENT_ID;
  buildAuthorizationUrl(req: { state: string }): string {
    return `${ISSUER}/authorize?state=${req.state}`;
  }
  async exchangeCode(params: { expectedNonce: string }): Promise<ValidatedClaims> {
    return {
      sub: SUBJECT,
      iss: ISSUER,
      aud: CLIENT_ID,
      nonce: params.expectedNonce,
      exp: Math.floor(Date.now() / 1000) + 3600,
      // No role claim -> PDP falls back to the role directory.
      claims: {},
    };
  }
}

function newAuthService(): AuthService {
  return new AuthService({
    oidc: new ScriptedOidcClient(),
    store: new InMemorySessionStore(),
    signer: new JoseTokenSigner({
      signingKey: new TextEncoder().encode('integration-test-signing-key-32bytes!!'),
    }),
  });
}

async function authenticatedCookie(baseUrl: string, service: AuthService): Promise<string> {
  const begin = await service.beginLogin('/');
  if (!begin.ok) throw new Error('beginLogin failed');
  const cbRes = await fetch(
    `${baseUrl}/auth/callback?code=abc&state=${encodeURIComponent(begin.value.state)}`,
    { headers: { 'x-forwarded-proto': 'https' } },
  );
  return (cbRes.headers.get('set-cookie') ?? '').split(';')[0];
}

function submittedEvent(atMs: number): WorkflowEvent {
  return {
    type: 'RequestSubmitted',
    requestId: 'req-audit',
    ownerId: 'owner-1',
    department: 'ENG',
    actorId: 'owner-1',
    status: 'Submitted',
    atMs,
  } as WorkflowEvent;
}

function buildApp(
  auth: AuthService,
  role: 'hr' | 'employee',
  audit: AuditService,
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(buildAuthRouter({ service: auth, cookieOptions: TEST_COOKIE }));
  const directory = new InMemoryRoleDirectory({
    [SUBJECT]: { role, departments: ['ENG'] },
  });
  const authz = new AuthzService({ directory });
  mountAuditRoutes(app, {
    auditService: audit,
    authService: auth,
    authz,
    cookieOptions: TEST_COOKIE,
  });
  return app;
}

async function listen(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('audit-trail read HTTP integration', () => {
  let server: Server;
  let baseUrl: string;
  let auth: AuthService;
  let audit: AuditService;

  beforeAll(async () => {
    auth = newAuthService();
    audit = createAuditService();
    await audit.recordEvent(submittedEvent(1));
    const app = buildApp(auth, 'hr', audit);
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails closed with 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/audit/requests/req-audit`);
    expect(res.status).toBe(401);
  });

  it('returns the ordered trail for an authorized auditor', async () => {
    const cookie = await authenticatedCookie(baseUrl, auth);
    const res = await fetch(`${baseUrl}/audit/requests/req-audit`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { records: { eventType: string }[] };
    expect(body.records).toHaveLength(1);
    expect(body.records[0].eventType).toBe('RequestSubmitted');
  });

  it('reports an intact chain via the verify endpoint', async () => {
    const cookie = await authenticatedCookie(baseUrl, auth);
    const res = await fetch(`${baseUrl}/audit/requests/req-audit/verify`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { integrity: string };
    expect(body.integrity).toBe('intact');
  });

  it('supports filtered query with a PII-free record view', async () => {
    const cookie = await authenticatedCookie(baseUrl, auth);
    const res = await fetch(`${baseUrl}/audit?eventType=RequestSubmitted`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Record<string, unknown>[] };
    expect(body.records).toHaveLength(1);
    // View is id-only: no email / name fields leak (BR-AUD-8).
    expect(body.records[0]).not.toHaveProperty('email');
    expect(body.records[0]).toHaveProperty('actorId');
  });
});

describe('audit-trail read HTTP — fail closed for non-auditor role', () => {
  it('returns 403 when the caller lacks the read permission', async () => {
    const auth = newAuthService();
    const audit = createAuditService();
    const app = buildApp(auth, 'employee', audit);
    const { server, baseUrl } = await listen(app);
    try {
      const cookie = await authenticatedCookie(baseUrl, auth);
      const res = await fetch(`${baseUrl}/audit/requests/req-audit`, { headers: { cookie } });
      expect(res.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
