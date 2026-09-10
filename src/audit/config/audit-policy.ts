/**
 * Injectable policy for unit-audit-trail.
 *
 * Mirrors the `balance-policy.ts` / `authz-policy.ts` pattern: a small,
 * overridable config object with safe defaults. The retention window is fixed
 * by `req-nfr-audit-retention` (`BR-AUD-7`) at seven years; the serializer
 * version tag is surfaced for `BR-AUD-6a` traceability.
 */

import { HASH_VERSION, SEVEN_YEARS_MS } from '../domain/audit-record.js';

export interface AuditPolicy {
  /** Retention window in ms. Records MUST NOT be purged before this (`BR-AUD-7`). */
  readonly retentionMs: number;
  /** Canonical-serializer version tag baked into every hash (`BR-AUD-6a`). */
  readonly hashVersion: string;
}

export const DEFAULT_AUDIT_POLICY: AuditPolicy = {
  retentionMs: SEVEN_YEARS_MS,
  hashVersion: HASH_VERSION,
};
