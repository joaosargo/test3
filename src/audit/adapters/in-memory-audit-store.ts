/**
 * In-memory `AuditStore` adapter for unit-audit-trail.
 *
 * Dev/test implementation of the append-only store. Production swaps a durable
 * append-only / WORM store behind the same port (infrastructure-design owns the
 * choice) — same hexagonal seam as the shipped `InMemorySessionStore`,
 * `InMemoryRoleDirectory`, `InMemoryBalanceCache`, and
 * `InMemoryVacationRequestRepository`.
 *
 * Enforces the immutability contract at runtime for dev safety (`BR-AUD-5`,
 * `BR-AUD-5a`): records are stored append-only in per-`requestId` partitions
 * (`BR-AUD-4`); there is no code path that overwrites, updates, or deletes a
 * stored record. Records are deep-frozen on ingest.
 */

import type { AuditRecord, RecordHash, TrailQuery } from '../domain/audit-record.js';
import type { AuditStore } from '../ports/audit-store.js';

/** Dedup key = `eventType|requestId|occurredAtMs` (`BR-AUD-2`). */
function dedupKey(eventType: string, requestId: string, occurredAtMs: number): string {
  return `${eventType}|${requestId}|${occurredAtMs}`;
}

export class InMemoryAuditStore implements AuditStore {
  /** Per-request partitions, each an ordered append-only list (`BR-AUD-4`). */
  private readonly partitions = new Map<string, AuditRecord[]>();
  /** Dedup index for idempotent ingestion (`BR-AUD-2`). */
  private readonly byKey = new Map<string, AuditRecord>();

  async append(record: AuditRecord): Promise<void> {
    const frozen = Object.freeze({ ...record });
    const partition = this.partitions.get(frozen.requestId) ?? [];
    partition.push(frozen);
    this.partitions.set(frozen.requestId, partition);
    this.byKey.set(dedupKey(frozen.eventType, frozen.requestId, frozen.occurredAtMs), frozen);
  }

  async findByKey(
    eventType: AuditRecord['eventType'],
    requestId: AuditRecord['requestId'],
    occurredAtMs: number,
  ): Promise<AuditRecord | null> {
    return this.byKey.get(dedupKey(eventType, requestId, occurredAtMs)) ?? null;
  }

  async chainHead(requestId: AuditRecord['requestId']): Promise<RecordHash | null> {
    const partition = this.partitions.get(requestId);
    if (!partition || partition.length === 0) return null;
    return partition[partition.length - 1].hash;
  }

  async findByRequest(requestId: AuditRecord['requestId']): Promise<AuditRecord[]> {
    // Return a copy so callers cannot mutate the stored partition.
    return [...(this.partitions.get(requestId) ?? [])];
  }

  async query(filter: TrailQuery): Promise<AuditRecord[]> {
    const all: AuditRecord[] = [];
    for (const partition of this.partitions.values()) all.push(...partition);
    return all.filter((r) => matches(r, filter));
  }
}

/** Apply the optional `TrailQuery` predicates (all-optional, AND-combined). */
function matches(record: AuditRecord, filter: TrailQuery): boolean {
  if (filter.department !== undefined && record.department !== filter.department) return false;
  if (filter.eventType !== undefined && record.eventType !== filter.eventType) return false;
  if (filter.actorId !== undefined && record.actorId !== filter.actorId) return false;
  if (filter.fromMs !== undefined && record.occurredAtMs < filter.fromMs) return false;
  if (filter.toMs !== undefined && record.occurredAtMs > filter.toMs) return false;
  return true;
}
