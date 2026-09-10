/**
 * In-memory `RecipientDirectoryPort` adapter for unit-notifications.
 *
 * Dev/test double. Resolves principals and role-in-department lookups from
 * in-memory maps so tests exercise the recipient policy (`BR-NOTIF-3/4`)
 * without a live directory. Production swaps a corporate directory (IdP / HRIS)
 * behind the same port, mirroring the in-memory adapter pattern of the shipped
 * units (`in-memory-role-directory.ts`, `in-memory-session-store.ts`).
 *
 * PII (`BR-PII-2`): holds contact PII (email, display name) for test data only;
 * never logs it.
 */

import type { PrincipalId } from '../../domain/entities.js';
import type { DepartmentCode } from '../../workflow/domain/value-objects.js';
import type { RecipientDirectoryPort } from '../ports/recipient-directory.js';
import type { RecipientContact } from '../domain/value-objects.js';
import type { DirectoryRole } from '../domain/recipient-policy.js';

export class InMemoryRecipientDirectory implements RecipientDirectoryPort {
  private readonly byPrincipal = new Map<PrincipalId, RecipientContact>();
  private readonly byRole = new Map<string, PrincipalId>();

  /** Register a principal's contact (test/setup helper). */
  addContact(contact: RecipientContact): this {
    this.byPrincipal.set(contact.principalId, contact);
    return this;
  }

  /** Map a role-in-department to a principal (test/setup helper). */
  assignActor(department: DepartmentCode, role: DirectoryRole, principalId: PrincipalId): this {
    this.byRole.set(this.roleKey(department, role), principalId);
    return this;
  }

  async resolve(principalId: PrincipalId): Promise<RecipientContact | null> {
    return this.byPrincipal.get(principalId) ?? null;
  }

  async resolveActor(department: DepartmentCode, role: DirectoryRole): Promise<RecipientContact | null> {
    const principalId = this.byRole.get(this.roleKey(department, role));
    if (!principalId) return null;
    return this.byPrincipal.get(principalId) ?? null;
  }

  private roleKey(department: DepartmentCode, role: DirectoryRole): string {
    return `${department}\u0000${role}`;
  }
}
