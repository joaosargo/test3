import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildStatusQueryRouter } from './status-query-router.js';
import { StatusQueryService } from '../services/status-query-service.js';
import { InMemoryVacationRequestRepository } from '../../workflow/adapters/in-memory-vacation-request-repository.js';
import { VacationRequest } from '../../workflow/domain/vacation-request.js';
import { AuthzService, InMemoryRoleDirectory } from '../../authz/index.js';
import type { AuthService } from '../../services/auth-service.js';
import type { Session } from '../../domain/entities.js';
import { ok } from '../../domain/result.js';

/**
 * Integration test for the status-query HTTP boundary (status-query-router +
 * requireSession). Drives an ephemeral http.Server with Node's built-in fetch
 * (no new dependency), covering the read status-code contract:
 * 200 own-list, 401 unauthenticated, 403 forbidden, 404 not-found,
 * 422 invalid status filter. Mirrors workflow-router.test.ts.
 *
 * A stub AuthService validates a bearer-style session token whose value encodes
 * `id|role|department`; a small middleware attaches the claims bag the service's
 * authz PDP reads.
 */

const COOKIE_NAME = 'vra_session';

function token(id: string, role: string, department: string): string {
  return `${id}|${role}|${department}`;
}

function stubAuthService(): AuthService {
  const svc = {
    async validateSession(t: string) {
      const [id] = t.split('|');
      const session: Session = {
        sessionId: `sess-${id}`,
        principalRef: id,
        createdAt: 0,
        lastSeenAt: 0,
        absoluteExpiryAt: Number.MAX_SAFE_INTEGER,
      };
      return ok(session);
    },
  };
  return svc as unknown as AuthService;
}

function attachClaims(): express.RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.cookie ?? '';
    const match = header.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (match) {
      const [, role, department] = decodeURIComponent(match[1]).split('|');
      (req as { principalClaims?: Record<string, unknown> }).principalClaims = {
        role,
        department,
      };
    }
    next();
  };
}

describe('status-query HTTP integration', () => {
  let server: Server;
  let baseUrl: string;
  const repository = new InMemoryVacationRequestRepository();

  beforeAll(async () => {
    // Seed one request owned by emp-1 in engineering, validated by a lead.
    let request = VacationRequest.submit({
      id: 'req-1',
      ownerId: 'emp-1',
      department: 'engineering',
      dates: { startDate: '2999-06-01', endDate: '2999-06-05' },
      atMs: 1000,
    });
    await repository.save(request);
    const validated = request.validate('lead-1', 2000, 'ok');
    if (validated.ok) {
      request = validated.value;
      await repository.save(request);
    }

    const service = new StatusQueryService({
      repo: repository,
      authz: new AuthzService({ directory: new InMemoryRoleDirectory() }),
    });

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json());
    app.use(attachClaims());
    app.use(
      buildStatusQueryRouter({
        service,
        authService: stubAuthService(),
        cookieOptions: { secure: false, httpOnly: true, sameSite: 'Lax', name: COOKIE_NAME },
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  function authed(id: string, role: string, department: string): Record<string, string> {
    return {
      cookie: `${COOKIE_NAME}=${encodeURIComponent(token(id, role, department))}`,
    };
  }

  it('401 when unauthenticated (no session cookie)', async () => {
    const res = await fetch(`${baseUrl}/status/requests`);
    expect(res.status).toBe(401);
  });

  it('200 with the owner\'s own requests', async () => {
    const res = await fetch(`${baseUrl}/status/requests`, {
      headers: authed('emp-1', 'employee', 'engineering'),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toContain('req-1');
  });

  it('422 for an unknown status filter value', async () => {
    const res = await fetch(`${baseUrl}/status/requests?status=Nope`, {
      headers: authed('emp-1', 'employee', 'engineering'),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.field).toBe('status');
  });

  it('403 when an HR approver reads a department outside scope', async () => {
    const res = await fetch(`${baseUrl}/status/departments/sales/requests`, {
      headers: authed('hr-1', 'hr', 'engineering'),
    });
    expect(res.status).toBe(403);
  });

  it('200 timeline for the owner, chronological with reason', async () => {
    const res = await fetch(`${baseUrl}/status/requests/req-1/timeline`, {
      headers: authed('emp-1', 'employee', 'engineering'),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      timeline: Array<{ to: string; reason?: string }>;
    };
    expect(body.status).toBe('Validated');
    expect(body.timeline.map((t) => t.to)).toEqual(['Submitted', 'Validated']);
  });

  it('404 for an unknown request id timeline', async () => {
    const res = await fetch(`${baseUrl}/status/requests/does-not-exist/timeline`, {
      headers: authed('emp-1', 'employee', 'engineering'),
    });
    expect(res.status).toBe(404);
  });
});
