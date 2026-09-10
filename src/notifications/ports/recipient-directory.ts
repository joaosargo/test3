/**
 * `RecipientDirectoryPort` — read-only port for resolving principals to
 * contact details (`domain-entities`, `business-rules` `BR-NOTIF-4`).
 *
 * The backing store (IdP / HRIS / internal directory) is an infrastructure
 * decision. In dev/test an in-memory stub is used; production wires the
 * corporate directory. The port also supports role-in-department resolution
 * (`resolveActor`) so the notification pipeline can look up "the team lead of
 * department X" for next-actor notifications (`BR-NOTIF-3`).
 *
 * PII (`BR-PII-2`): resolved `RecipientContact` is PII-bearing and
 * transient — used only to build an outbound message, never logged.
 */

import type { PrincipalId } from '../../domain/entities.js';
import type { DepartmentCode } from '../../workflow/domain/value-objects.js';
import type { RecipientContact } from '../domain/value-objects.js';
import type { DirectoryRole } from '../domain/recipient-policy.js';

export interface RecipientDirectoryPort {
  /** Resolve a known principal to their contact. Returns `null` if unresolvable. */
  resolve(principalId: PrincipalId): Promise<RecipientContact | null>;

  /**
   * Resolve the principal holding a role within a department (e.g. "the team
   * lead of Engineering"). Returns `null` if no match — the caller records
   * `skipped(RECIPIENT_UNRESOLVED)` per `BR-NOTIF-8`.
   */
  resolveActor(department: DepartmentCode, role: DirectoryRole): Promise<RecipientContact | null>;
}
