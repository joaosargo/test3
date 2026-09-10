import { describe, it, expect } from 'vitest';
import { AuthzService } from './authz-service.js';
import { InMemoryRoleDirectory } from '../adapters/in-memory-role-directory.js';
import type { RoleDirectoryPort } from '../ports/role-directory.js';
import type { AuthenticatedPrincipal } from '../../domain/entities.js';

function principal(
  principalId: string,
  rawClaims: AuthenticatedPrincipal['rawClaims'] = {},
): AuthenticatedPrincipal {
  return { principalId, rawClaims };
}

describe('AuthzService (PDP) — story-rbac-role-access', () => {
  const directory = new InMemoryRoleDirectory();
  const authz = new AuthzService({ directory });

  // --- Happy paths per role (req-rbac-three-roles-hr-scoping) ---

  it('grants an employee request:submit from a role claim', async () => {
    const res = await authz.decide(principal('emp-1', { role: 'employee' }), 'request:submit');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.role).toBe('employee');
  });

  it('grants a team lead request:validate from a role claim', async () => {
    const res = await authz.decide(principal('lead-1', { role: 'team-lead' }), 'request:validate');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.role).toBe('team-lead');
  });

  it('grants HR request:approve within their department scope', async () => {
    const res = await authz.decide(
      principal('hr-1', { role: 'hr', department: 'engineering' }),
      'request:approve',
      { department: 'engineering' },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.departmentScope).toEqual(['engineering']);
  });

  it('accepts a role claim delivered as an array', async () => {
    const res = await authz.decide(principal('emp-2', { role: ['employee'] }), 'request:view-own');
    expect(res.ok).toBe(true);
  });

  // --- Deny/edge cases (fail-closed, deny-by-default) ---

  it('denies UNAUTHENTICATED when no principal is present', async () => {
    const res = await authz.decide(undefined, 'request:submit');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.reason).toBe('UNAUTHENTICATED');
  });

  it('denies PERMISSION_DENIED when the role lacks the permission', async () => {
    // Employee cannot approve.
    const res = await authz.decide(principal('emp-3', { role: 'employee' }), 'request:approve');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.reason).toBe('PERMISSION_DENIED');
  });

  it('denies DEPARTMENT_OUT_OF_SCOPE for HR acting on another department', async () => {
    const res = await authz.decide(
      principal('hr-2', { role: 'hr', department: 'engineering' }),
      'request:approve',
      { department: 'finance' },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.reason).toBe('DEPARTMENT_OUT_OF_SCOPE');
  });

  it('denies ROLE_UNKNOWN for a role value outside the closed set', async () => {
    const res = await authz.decide(principal('x-1', { role: 'superadmin' }), 'request:submit');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.reason).toBe('ROLE_UNKNOWN');
  });

  it('does not leak PII in deny messages', async () => {
    const res = await authz.decide(
      principal('secret-sub-123', { role: 'employee', department: 'top-secret-dept', email: 'a@b.co' }),
      'request:approve',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).not.toContain('secret-sub-123');
      expect(res.error.message).not.toContain('top-secret-dept');
      expect(res.error.message).not.toContain('a@b.co');
    }
  });
});

describe('AuthzService — directory fallback & fail-closed (req-nfr-security-pii)', () => {
  it('falls back to the directory when the role claim is absent', async () => {
    const directory = new InMemoryRoleDirectory({
      'dir-emp': { role: 'employee', departments: ['sales'] },
    });
    const authz = new AuthzService({ directory });
    const res = await authz.decide(principal('dir-emp'), 'request:submit');
    expect(res.ok).toBe(true);
  });

  it('denies ROLE_UNRESOLVED when fallback is disabled and no claim exists', async () => {
    const directory = new InMemoryRoleDirectory();
    const authz = new AuthzService({
      directory,
      policy: { roleClaim: 'role', departmentClaim: 'department', directoryFallback: false },
    });
    const res = await authz.decide(principal('no-claims'), 'request:submit');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.reason).toBe('ROLE_UNRESOLVED');
  });

  it('fails closed with DIRECTORY_UNAVAILABLE when the directory throws', async () => {
    const throwing: RoleDirectoryPort = {
      lookup: async () => {
        throw new Error('dynamo down');
      },
    };
    const authz = new AuthzService({ directory: throwing });
    const res = await authz.decide(principal('any'), 'request:submit');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.reason).toBe('DIRECTORY_UNAVAILABLE');
  });

  it('fails closed with DIRECTORY_UNAVAILABLE when the principal is unknown', async () => {
    const directory = new InMemoryRoleDirectory();
    const authz = new AuthzService({ directory });
    const res = await authz.decide(principal('ghost'), 'request:submit');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.reason).toBe('DIRECTORY_UNAVAILABLE');
  });
});
