import { describe, it, expect } from 'vitest';
import { InMemoryRoleDirectory } from './in-memory-role-directory.js';

describe('InMemoryRoleDirectory adapter (req-nfr-security-pii)', () => {
  it('returns a seeded assignment', async () => {
    const dir = new InMemoryRoleDirectory({
      'p-1': { role: 'hr', departments: ['engineering', 'sales'] },
    });
    const res = await dir.lookup('p-1');
    expect(res).not.toBeNull();
    expect(res?.role).toBe('hr');
    expect(res?.departments).toEqual(['engineering', 'sales']);
  });

  it('returns null for an unknown principal (fail-closed upstream)', async () => {
    const dir = new InMemoryRoleDirectory();
    expect(await dir.lookup('missing')).toBeNull();
  });

  it('upserts an assignment via set()', async () => {
    const dir = new InMemoryRoleDirectory();
    dir.set('p-2', { role: 'employee', departments: ['ops'] });
    const res = await dir.lookup('p-2');
    expect(res?.role).toBe('employee');
  });
});
