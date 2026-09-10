/**
 * Canonical serialization + hashing for unit-audit-trail.
 *
 * Grounded in business-rules `BR-AUD-6` (tamper-evident hash chain) and
 * `BR-AUD-6a` (canonical serialization). The bytes hashed for a record are
 * produced by a single deterministic serializer with stable key order and
 * fixed number formatting, so the same record always yields the same hash
 * across runtimes. The serializer is pure and its format is version-tagged by
 * the caller (`HASH_VERSION`) — a future format change bumps the tag rather
 * than silently invalidating old chains.
 *
 * Only high-entropy / digest primitives are used from `node:crypto`; there is
 * no bespoke protocol crypto here (mirrors the `src/domain/crypto.ts` posture).
 */

import { createHash, randomUUID } from 'node:crypto';

/**
 * Deterministically serialize a plain value to a canonical string.
 *
 * Rules (`BR-AUD-6a`):
 *  - Objects: keys sorted lexicographically; `undefined` fields omitted.
 *  - Numbers: finite numbers via `Number` round-trip (rejects NaN/Infinity).
 *  - Arrays: element order preserved.
 *  - Strings/booleans/null: JSON-encoded.
 *
 * Throws on non-finite numbers or unsupported types — those indicate a
 * programmer error upstream (the record factory only ever passes vetted
 * primitives), consistent with the throw-for-infra/programmer-error convention.
 */
export function canonicalSerialize(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('canonicalSerialize: non-finite number');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((el) => canonicalSerialize(el)).join(',')}]`;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${canonicalSerialize(obj[k])}`)
      .join(',');
    return `{${body}}`;
  }

  throw new Error(`canonicalSerialize: unsupported type ${t}`);
}

/** SHA-256 hex digest of the given canonical string (`BR-AUD-6`). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Generate a fresh opaque audit id (UUID). */
export function newAuditId(): string {
  return randomUUID();
}
