import { describe, it, expect } from 'vitest';
import { roleGrants, permissionsFor } from './role-policy.js';
import { ROLES } from './roles.js';

describe('role-policy — precompiled grant table (req-rbac-three-roles-hr-scoping)', () => {
  it('grants employee submit/view-own only', () => {
    expect(roleGrants('employee', 'request:submit')).toBe(true);
    expect(roleGrants('employee', 'request:view-own')).toBe(true);
    expect(roleGrants('employee', 'request:approve')).toBe(false);
    expect(roleGrants('employee', 'request:validate')).toBe(false);
  });

  it('grants team-lead validate/view-team only', () => {
    expect(roleGrants('team-lead', 'request:validate')).toBe(true);
    expect(roleGrants('team-lead', 'request:view-team')).toBe(true);
    expect(roleGrants('team-lead', 'request:approve')).toBe(false);
    expect(roleGrants('team-lead', 'request:submit')).toBe(false);
  });

  it('grants hr approve/view-department only', () => {
    expect(roleGrants('hr', 'request:approve')).toBe(true);
    expect(roleGrants('hr', 'request:view-department')).toBe(true);
    expect(roleGrants('hr', 'request:validate')).toBe(false);
  });

  it('does not inherit permissions across roles (deny-by-default)', () => {
    // A team-lead is not implicitly an employee.
    expect(roleGrants('team-lead', 'request:submit')).toBe(false);
    // HR is not implicitly a team-lead.
    expect(roleGrants('hr', 'request:validate')).toBe(false);
  });

  it('exposes a defensive copy of a role permission set', () => {
    const perms = permissionsFor('employee');
    expect(perms).toContain('request:submit');
    // Mutating the returned array must not affect subsequent reads.
    (perms as string[]).push('request:approve');
    expect(roleGrants('employee', 'request:approve')).toBe(false);
  });

  it('covers exactly the three closed roles', () => {
    expect(ROLES).toEqual(['employee', 'team-lead', 'hr']);
  });
});
