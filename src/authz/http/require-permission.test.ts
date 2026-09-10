import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { requirePermission, type AuthorizedRequest } from './require-permission.js';
import { AuthzService } from '../services/authz-service.js';
import { InMemoryRoleDirectory } from '../adapters/in-memory-role-directory.js';
import type { Session } from '../../domain/entities.js';

/**
 * Unit tests for the requirePermission guard (story-rbac-role-access). Uses
 * lightweight fake Express req/res objects — the guard is pure middleware, so
 * no live server is required (the auth-router integration test covers the
 * wired stack for unit-platform-auth).
 */

function fakeSession(principalRef: string): Session {
  const now = Date.now();
  return {
    sessionId: 'sid-1',
    principalRef,
    createdAt: now,
    lastSeenAt: now,
    absoluteExpiryAt: now + 3600_000,
  };
}

function fakeRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._json = body;
      return this;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

describe('requirePermission guard — story-rbac-role-access', () => {
  const directory = new InMemoryRoleDirectory({
    'lead-1': { role: 'team-lead', departments: ['engineering'] },
  });
  const authz = new AuthzService({ directory });

  it('calls next() and attaches the grant on allow', async () => {
    const req = {
      session: fakeSession('emp-1'),
      principalClaims: { role: 'employee' },
    } as unknown as AuthorizedRequest;
    const res = fakeRes();
    const next = vi.fn();

    await requirePermission(authz, 'request:submit')(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.authzGrant?.role).toBe('employee');
    expect(res._status).toBe(0);
  });

  it('responds 401 when there is no session (UNAUTHENTICATED)', async () => {
    const req = {} as AuthorizedRequest;
    const res = fakeRes();
    const next = vi.fn();

    await requirePermission(authz, 'request:submit')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect((res._json as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('responds 403 when the role lacks the permission (PERMISSION_DENIED)', async () => {
    const req = {
      session: fakeSession('emp-2'),
      principalClaims: { role: 'employee' },
    } as unknown as AuthorizedRequest;
    const res = fakeRes();
    const next = vi.fn();

    await requirePermission(authz, 'request:approve')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._json as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');
  });

  it('resolves role via the directory when claims are absent', async () => {
    const req = { session: fakeSession('lead-1') } as unknown as AuthorizedRequest;
    const res = fakeRes();
    const next = vi.fn();

    await requirePermission(authz, 'request:validate')(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.authzGrant?.role).toBe('team-lead');
  });

  it('enforces the HR per-department ABAC overlay via a resource resolver', async () => {
    const req = {
      session: fakeSession('hr-1'),
      principalClaims: { role: 'hr', department: 'engineering' },
    } as unknown as AuthorizedRequest;
    const res = fakeRes();
    const next = vi.fn();

    await requirePermission(authz, 'request:approve', {
      resourceResolver: () => ({ department: 'finance' }),
    })(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._json as { error: { code: string } }).error.code).toBe('DEPARTMENT_OUT_OF_SCOPE');
  });
});
