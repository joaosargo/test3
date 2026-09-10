import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildWorkflowRouter } from './workflow-router.js';
import { WorkflowService } from '../services/workflow-service.js';
import { InMemoryVacationRequestRepository } from '../adapters/in-memory-vacation-request-repository.js';
import { InMemoryEventPublisher } from '../adapters/in-memory-event-publisher.js';
import { AuthzService, InMemoryRoleDirectory } from '../../authz/index.js';
import type { AuthService } from '../../services/auth-service.js';
import type { Session } from '../../domain/entities.js';
import { ok } from '../../domain/result.js';

/**
 * Integration test for the workflow HTTP boundary (workflow-router +
 * requireSession + requirePermission). Drives an ephemeral http.Server with
 * Node's built-in fetch (no new dependency), covering the status-code contract:
 * 201 submit, 200 validate/approve, 401 unauthenticated, 403 forbidden,
 * 404 not-found, 409 stale-state.
 *
 * A stub AuthService validates a bearer-style session token whose value encodes
 * the principal id + role + department; a small middleware attaches the claims
 * bag the authz PDP reads. This isolates the workflow router from the full OIDC
 * flow (exercised in the auth unit's own integration test).
 */

const COOKIE_NAME = 'vra_session';

/** Encode a fake session token as `id|role|department`. */
function token(id: string, role: string, department: string): string {
  return `${id}|${role}|${department}`;
}

/** Stub AuthService — only `validateSession` is consumed by requireSession. */
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

/** Attach the principal claims bag (role/department) decoded from the token. */
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

describe('workflow HTTP integration', () => {
  let server: Server;
  let baseUrl: string;
  const repository = new InMemoryVacationRequestRepository();
  const events = new InMemoryEventPublisher();
  const service = new WorkflowService({
    repository,
    events,
    authz: new AuthzService({ directory: new InMemoryRoleDirectory() }),
    now: () => 1_000_000,
  });

  beforeAll(async () => {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json());
    app.use(attachClaims());
    app.use(
      buildWorkflowRouter({
        service,
        authService: stubAuthService(),
        authz: new AuthzService({ directory: new InMemoryRoleDirectory() }),
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
      'content-type': 'application/json',
      cookie: `${COOKIE_NAME}=${encodeURIComponent(token(id, role, department))}`,
    };
  }

  const future = { startDate: '2999-06-01', endDate: '2999-06-05' };

  it('401 when unauthenticated (no session cookie)', async () => {
    const res = await fetch(`${baseUrl}/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(future),
    });
    expect(res.status).toBe(401);
  });

  it('201 on submit and 200 through validate -> approve', async () => {
    const submit = await fetch(`${baseUrl}/requests`, {
      method: 'POST',
      headers: authed('emp-1', 'employee', 'engineering'),
      body: JSON.stringify(future),
    });
    expect(submit.status).toBe(201);
    const created = (await submit.json()) as { id: string; version: number };
    expect(created.version).toBe(1);

    const validate = await fetch(`${baseUrl}/requests/${created.id}/validate`, {
      method: 'POST',
      headers: authed('lead-1', 'team-lead', 'engineering'),
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(validate.status).toBe(200);

    const approve = await fetch(`${baseUrl}/requests/${created.id}/approve`, {
      method: 'POST',
      headers: authed('hr-1', 'hr', 'engineering'),
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(approve.status).toBe(200);
    const approved = (await approve.json()) as { status: string };
    expect(approved.status).toBe('Approved');
  });

  it('403 when an employee attempts an HR approval', async () => {
    const submit = await fetch(`${baseUrl}/requests`, {
      method: 'POST',
      headers: authed('emp-2', 'employee', 'engineering'),
      body: JSON.stringify(future),
    });
    const created = (await submit.json()) as { id: string };
    const res = await fetch(`${baseUrl}/requests/${created.id}/approve`, {
      method: 'POST',
      headers: authed('emp-2', 'employee', 'engineering'),
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(res.status).toBe(403);
  });

  it('404 for an unknown request id', async () => {
    const res = await fetch(`${baseUrl}/requests/does-not-exist/validate`, {
      method: 'POST',
      headers: authed('lead-1', 'team-lead', 'engineering'),
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it('409 on a stale expectedVersion', async () => {
    const submit = await fetch(`${baseUrl}/requests`, {
      method: 'POST',
      headers: authed('emp-3', 'employee', 'engineering'),
      body: JSON.stringify(future),
    });
    const created = (await submit.json()) as { id: string };
    const res = await fetch(`${baseUrl}/requests/${created.id}/validate`, {
      method: 'POST',
      headers: authed('lead-1', 'team-lead', 'engineering'),
      body: JSON.stringify({ expectedVersion: 99 }),
    });
    expect(res.status).toBe(409);
  });
});
