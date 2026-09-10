---
consumes: [performance-design, security-design, scalability-design, reliability-design, logical-components, components, services, business-logic-model]
unit: unit-audit-trail
stage: infrastructure-design
---

# Infrastructure Services — `unit-audit-trail`

The backing AWS services for the **Immutable Audit Trail** unit: the durable
append-only / WORM store, the event-ingest transport, the integrity-sweep and
retention lifecycle jobs, caching posture, and external-service integration.
These choices realise the persistence contract in `business-logic-model` (the
`AuditStore` port — `append` + reads only), the at-least-once / idempotent ingest
in `reliability-design` (RD-AUD-4), the per-`requestId` partition + secondary
index in `scalability-design` (SC-AUD-2/6/7) and `performance-design`
(PD-AUD-6/7), and the WORM/integrity controls in `security-design`
(SD-AUD-6/9). They inherit the modular-monolith service grouping of `services`
and `components`, and honour the component ownership in `logical-components`
(C2/C5/C7/C8 owned; bus, compute, network shared).

## Database — the durable append-only audit store (C5)

**Amazon DynamoDB**, single table keyed to the request sub-chain — the concrete
realisation of the `AuditStore` port `business-logic-model` and
`tech-stack-decisions` left open.

- **Table**: `audit-trail-<env>`.
- **Key schema** (append-only, per-`requestId` chain — `scalability-design`
  SC-AUD-2/6):
  - Partition key `PK = REQ#<requestId>`.
  - Sort key `SK = TX#<zero-padded seq>` — one immutable item per accepted
    transition (`business-logic-model` `recordEvent` step 5). Items are
    **write-once**: the IAM policy and a CDK aspect forbid
    `UpdateItem`/`DeleteItem`, so append-only is structural, not conventional
    (`security-design` SD-AUD-3/5, `req-constraint-append-only-store`).
- **Idempotent ingest** (`reliability-design` RD-AUD-4, `performance-design`
  PD-AUD-4): the append uses `ConditionExpression: attribute_not_exists(PK)
  AND attribute_not_exists(SK)` and a dedup key of
  `(eventType, requestId, occurredAtMs)`; a redelivery collapses to the existing
  record with no second row. The dedup lookup is an exact-match key read
  (`performance-design` PD-AUD-4 "single point read, not a scan").
- **`queryTrail` GSI** (`performance-design` PD-AUD-7, `scalability-design`
  SC-AUD-7): a global secondary index `GSI-Dept` with
  `PK = department`, `SK = occurredAtMs`, projecting `eventType`/`actorId` for
  filter predicates. This keeps the one corpus-scanning read off a full scan and
  inside ≤ 500 ms p95 as the 7-year corpus grows; unbounded result sets are
  paginated with a cursor over `(occurredAtMs, auditId)`.
- **Capacity**: on-demand in dev/staging (zero idle cost for a bursty workload);
  provisioned + autoscaling in production. **No TTL** — history is retained, not
  expired (`scalability-design` SC-AUD-9/12).
- **Encryption at rest**: SSE-KMS (`security-design` SD-AUD-13) — AWS-managed
  minimum, customer-managed in production.
- **PITR**: enabled, giving the point-in-time recovery `reliability-design`
  RD-AUD-11 requires (append-only means restore yields a consistent ordered
  timeline with no in-place-edit reconciliation).

## Storage-layer immutability — S3 Object Lock (WORM) tier

DynamoDB enforces append-only at the application/IAM layer, but
`security-design` SD-AUD-9 requires immutability to hold **even against an
operator with store credentials**. That is served by an **S3 bucket with Object
Lock in COMPLIANCE mode**:

- Each `AuditRecord` (and/or per-`requestId` chain segment) is written to
  `s3://audit-trail-worm-<env>/REQ#<requestId>/...` with a **retention date =
  `retainUntilMs`** (`recordedAtMs + SEVEN_YEARS_MS`, `business-logic-model`).
- **COMPLIANCE mode**: no principal — not even the account root — can delete or
  shorten retention before expiry, closing the operator-credential threat
  (`security-design` SD-AUD-9 threat table).
- **Versioning + `BlockPublicAccess.BLOCK_ALL`**, SSE-KMS, access logging to a
  dedicated log bucket (CDK security defaults).
- The stored bytes are the canonical, version-tagged serialization
  (`security-design` SD-AUD-7), so the S3 copy is independently hash-verifiable
  by `verifyChain`.

This two-tier split (DynamoDB for hot reads, S3 Object Lock for WORM evidence)
sits behind the single `AuditStore` port (`logical-components` LC-AUD-3), so the
concrete tiering is swappable and remains procurement-gated
(`req-constraint-build-gate`). **QLDB was considered and rejected** — it is being
deprecated by AWS, and its ledger value is redundant with the app's own SHA-256
hash chain (`security-design` SD-AUD-6); adopting it would fragment the shipped
DynamoDB seam (see `memory.md` tradeoff).

## Messaging — EventBridge rule → SQS → idempotent ingest (C2)

This unit **subscribes**; it publishes nothing (`business-logic-model` "Outbound:
none"; `logical-components` LC-AUD-1). The workflow unit publishes its five
domain events to the shared EventBridge bus (owned by Platform / the workflow
unit's outbox); this unit owns only its **subscription + buffer + DLQ**:

```
shared EventBridge bus (workflow publishes 5 detail-types)
        │  EventBridge rule (this unit's — matches the 5 detail-types)
        ▼
   SQS queue  audit-ingest-<env>        ── redrive ──►  SQS DLQ  audit-ingest-dlq-<env>
        │  (at-least-once delivery)                        │ (after 5 attempts)
        ▼                                                   ▼
   recordEvent handler (C1, idempotent)                 alarm + operator review
        ▼
   DynamoDB append + S3 WORM write
```

- **Amazon EventBridge rule** on the shared bus for the five workflow
  `detail-type`s only — the anti-corruption membrane (`logical-components`
  LC-AUD-1); this unit has no access to the workflow's request table.
- **Amazon SQS (standard)** as the durable ingest buffer, so audit downtime never
  back-pressures the command path (`reliability-design` RD-AUD-3,
  `performance-design` PD-AUD-1 "fire-and-forget, never awaited"). **Standard,
  not FIFO**: the app dedups idempotently and reconstructs ordering from
  `occurredAtMs` + the chain (`reliability-design` RD-AUD-7), so FIFO's
  throughput cap buys nothing (see `memory.md` tradeoff).
- **DLQ after N attempts** (design intent 5 — `reliability-design` RD-AUD-5):
  malformed / repeatedly-failing events are dead-lettered and **alerted**, never
  silently dropped, so systematic event-shape drift is an operational signal.
- **Retry with backoff** on transient `AuditStore.append` failure re-queues (does
  not ack), so the bus/queue redelivers and the idempotent guard prevents a
  duplicate row (`reliability-design` RD-AUD-4). **No circuit breaker on ingest**
  — tripping open would risk dropping events (`reliability-design` resilience
  table).

## Scheduled jobs — integrity sweep (C7) and retention lifecycle (C8)

- **Integrity-sweep job (C7)**: an **EventBridge Scheduler** rule invokes
  `verifyChain` over recently-written partitions on a **daily** cadence, plus a
  **full sweep after any restore/migration** (`reliability-design` RD-AUD-8,
  `security-design` SD-AUD-8). The job is pure/side-effect-free — it leaves the
  trail byte-identical (`performance-design` PD-AUD-8) — and emits an integrity
  **alarm** on any hash-mismatch/broken-link, not a service outage.
- **Retention / tiering lifecycle (C8)**: aged records transition to a **colder,
  still-WORM, still-hash-verifiable** tier (S3 Glacier Instant/Flexible Retrieval
  **with Object Lock retained**) via S3 lifecycle rules keyed to age
  (`scalability-design` SC-AUD-11). The transition **never mutates or drops** a
  record before `retainUntilMs`; a colder tier may raise `queryTrail` latency for
  old date ranges but must still meet the auditor's tolerance. **Purge is
  out-of-band and post-retention only** (`scalability-design` SC-AUD-12) — a
  separate lifecycle job operating on expired `retainUntilMs`, never a runtime
  capability of this unit.

## Caching — deliberately none on the read surface

- **No read cache** (`performance-design` PD-AUD-9). Auditor reads are
  low-frequency compliance activity and must reflect the durable trail *exactly*
  (`security-design` SD-AUD-8 evidence integrity). A cache would add staleness
  risk and invalidation complexity for no throughput benefit at single-digit
  concurrency (`scalability-design` SC-AUD-4). This is a conscious departure from
  the generic "cache read-heavy APIs" pattern (see `memory.md` deviation).
- **Connection/resource pooling** for the durable adapter instead
  (`performance-design` PD-AUD-12): the DynamoDB/S3 clients are reused
  (pool sized to ingest concurrency × handling time × 1.5) rather than
  per-event, keeping the async ingest cheap under seasonal bursts.

## External Service Integrations & Configuration

- **`unit-platform-auth` / `unit-platform-authz` (in-process)**: session
  validation and the authz PDP are library calls on the read surface
  (`security-design` SD-AUD-1), not network services — no infra owned here, both
  **Critical to reads** and fail-closed (`reliability-design` degradation table).
- **`unit-request-workflow` (event source)**: consumed only via the shared
  EventBridge bus through the C3 ACL mapper (`logical-components` LC-AUD-1); never
  a direct call, never shared table access.
- **Service discovery**: in-process modules resolve by import within the monolith
  (`logical-components` embedded boundary) — none needed.
- **Configuration & secrets**: table name, bucket name, queue/DLQ ARNs, and KMS
  key ARNs are injected via **SSM Parameter Store / Secrets Manager** at task
  start (`security-design` SD-AUD-14 "no secrets in code"); the CDK stack writes
  them and the task reads them, so nothing is hardcoded.
