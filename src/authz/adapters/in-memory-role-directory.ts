/**
 * In-memory RoleDirectory adapter for unit-platform-authz.
 *
 * Dev/test double for `RoleDirectoryPort`. Production swaps in a DynamoDB-backed
 * read-model (`deployment-architecture-unit-platform-authz` — "Storage Strategy
 * — Role/Department Directory Read Model") behind the same port; this adapter
 * keeps the PDP unit-testable without live infra, mirroring
 * `in-memory-session-store.ts` in unit-platform-auth.
 *
 * PII (`req-nfr-security-pii`): the map holds department assignments (PII). This
 * adapter never logs entries and exposes no enumeration API.
 */

import type { RoleAssignment, RoleDirectoryPort } from '../ports/role-directory.js';

export class InMemoryRoleDirectory implements RoleDirectoryPort {
  private readonly assignments = new Map<string, RoleAssignment>();

  constructor(seed?: Record<string, RoleAssignment>) {
    if (seed) {
      for (const [principalId, assignment] of Object.entries(seed)) {
        this.assignments.set(principalId, assignment);
      }
    }
  }

  /** Upsert an assignment. Test/seed helper — not part of the port contract. */
  set(principalId: string, assignment: RoleAssignment): void {
    this.assignments.set(principalId, assignment);
  }

  async lookup(principalId: string): Promise<RoleAssignment | null> {
    return this.assignments.get(principalId) ?? null;
  }
}
