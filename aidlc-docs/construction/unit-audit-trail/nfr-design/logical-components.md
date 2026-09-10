---
consumes: [performance-requirements, security-requirements, scalability-requirements, reliability-requirements, tech-stack-decisions, business-logic-model]
unit: unit-audit-trail
stage: nfr-design
---

# Logical Components — `unit-audit-trail`

Logical infrastructure component inventory for the **Immutable Audit Trail**
unit. This bridges the NFR design decisions (`performance-design`,
`security-design`, `scalability-design`, `reliability-design`) into a
component-level view of **where each NFR pattern applies**, so infrastructure-
design can map logical components to concrete resources. It is grounded in the
event-sink topology in `business-logic-model`, the stateless-horizontal /
durable-append-only / hexagonal-`AuditStore` selections in
`tech-stack-decisions`, the ingest/read budgets in `performance-requirements`,
the WORM/integrity controls in `security-requirements`, the 7-year growth model
in `scalability-requirements`, and the completeness SLO and degradation tiers in
`reliability-requirements`.

Architecturally this unit is an **embedded in-process module** of the modular
monolith (same posture as the shipped units and the `unit-request-workflow`
dependency): its query surface runs as Express routes inside the shared task,
and its ingest handler is a subscriber to the shared choreography bus. It **owns
no compute of its own** beyond that module boundary; it **owns** its durable
append-only store, its bus subscription + DLQ, and its integrity-verification
job.

## Logical Component Inventory

| # | Logical component | Responsibility | Ownership | NFR patterns applied |
|---|-------------------|----------------|-----------|----------------------|
| C1 | **Ingest handler** (`recordEvent`) | Validate → dedup → chain → append one `AuditRecord` per event | Owned (in-process module) | O(1) ingest (perf); idempotent dedup, fail-closed, retry-then-DLQ (rel); stateless horizontal (scal) |
| C2 | **Event subscription + DLQ** | Subscribe to the shared bus's 5 workflow events; dead-letter malformed/failed | Owned (subscription rule + DLQ); bus is Platform-shared | At-least-once + DLQ (rel); no back-pressure to command path (perf) |
| C3 | **Inbound ACL mapper** | Translate published `WorkflowEvent` → `AuditRecord` shape; copy only pseudonymous/non-PII fields | Owned | PII minimisation by construction (sec) |
| C4 | **Integrity/hash-chain engine** | `AuditRecord.fromEvent` + canonical serialize + SHA-256; `verifyChain` walk | Owned (pure domain) | Tamper-evident chain, version-tagged canonical serialize (sec); per-record hashing (perf) |
| C5 | **`AuditStore` port + durable adapter** | Append-only persistence, single-key reads, `queryTrail` index read | Owned (the durable store is this unit's) | WORM at-rest (sec); per-`requestId` partition + secondary index (scal/perf); ≥11-nines durability, PITR (rel) |
| C6 | **Auditor read surface** (`getRequestTrail`/`queryTrail`/`verifyChain` routes) | Guarded read-only HTTP endpoints | Owned (in-process Express routes) | `requireSession → requirePermission` deny-by-default (sec); bounded read latency + pagination (perf) |
| C7 | **Integrity-sweep job** | Scheduled `verifyChain` over recent partitions + post-restore full sweep | Owned (scheduled job) | Continuous integrity verification (rel/sec); off the read path (perf) |
| C8 | **Retention/tiering lifecycle** | Enforce `retainUntilMs`; cold-tier aged records; post-retention out-of-band purge | Owned policy; mechanism at infra-design | 7-year monotonic retention, cold tiering, no early purge (scal/sec/rel) |

### Consumed (not owned) dependencies

| Dependency | Owner | Relationship | Failure posture |
|------------|-------|--------------|-----------------|
| Session validation | `unit-platform-auth` | In-process library call on the read surface | Critical to reads; fail-closed `401` |
| Authz decision (PDP) | `unit-platform-authz` | In-process `requirePermission` on the read surface | Critical to reads; fail-closed `err(forbidden)` |
| Choreography bus (event source) | Platform (shared EventBridge-class bus) | Subscribe-only; publishes nothing | Important to ingest; buffered/redelivered on sink downtime |
| `WorkflowEvent` language | `unit-request-workflow` | Conformist consumer via C3 ACL | Read-only; isolated from event-shape drift |
| Shared compute (ECS task + ALB), VPC, observability plane, CI/CD | Platform | Shares; adds its own metrics/alarms | Multi-AZ posture contains task-instance loss |

## Service Boundaries & Isolation

- **LC-AUD-1 — Terminal sink, lowest-coupling position.** The unit **subscribes**
  to the bus and **calls no other unit back** (`business-logic-model` Data Flow:
  "Outbound: none"). Its only inbound coupling is the published `WorkflowEvent`
  language, isolated behind the C3 ACL mapper (conformist-with-ACL). The bus is
  the anti-corruption membrane: this unit has subscribe permission on the
  workflow `detail-type`s only and **no** access to the workflow's request table.
- **LC-AUD-2 — Read/write isolation.** Ingest (C1/C2) and the read surface (C6)
  are decoupled — they share only the durable store (C5) and never call each
  other (`scalability-requirements` SCAL-AUD-4). A read-side overload cannot
  stall ingest, and ingest backlog cannot stall reads; they scale on independent
  signals (`scalability-design` SC-AUD-4/13).
- **LC-AUD-3 — Pure domain core, swappable adapters.** The integrity engine (C4)
  and record model are pure and store-agnostic (hexagonal seam,
  `tech-stack-decisions`); the in-memory adapter serves dev/test and the durable
  WORM adapter serves production behind the same `AuditStore` port — the
  signing-seam enhancement (`security-design` SD-AUD-10) plugs in here without a
  chain migration.

## Failure Domains & Blast Radius

- **FD-1 — Ingest-consumer instance loss.** Affects only unprocessed events on
  the bus, which are redelivered to another instance (stateless + idempotent,
  `reliability-design` RD-AUD-4). Cannot corrupt already-appended records
  (append-only, immutable). Blast radius: **in-flight events on that instance**;
  no data loss.
- **FD-2 — Durable store outage (C5).** Critical to the trail's mission but
  **not** to the workflow command path: ingest retries and re-queues (no
  drop-on-open), the workflow keeps committing (`reliability-design` RD-AUD-3),
  and the read surface returns retryable errors. Blast radius: **delayed
  recording + degraded reads**, bounded by the completeness SLO (RD-AUD-1).
- **FD-3 — Bus/subscription outage (C2).** Delays ingest; committed transitions
  are buffered upstream and recorded on recovery. Blast radius: **compliance-
  visibility latency**, never workflow availability or transition loss.
- **FD-4 — Auth/authz dependency outage.** Fails the read surface closed
  (`401` / `forbidden`) but leaves ingest and the durable evidence untouched.
  Blast radius: **auditor read availability only** (`security-design`
  SD-AUD-1/2).
- **FD-5 — Silent corruption / tampering in C5.** Detected by the C7 scheduled
  `verifyChain` sweep as an integrity incident, not silent decay
  (`reliability-design` RD-AUD-8, `security-design` SD-AUD-6/8). Blast radius:
  **detectable and provable**, bounded to the affected partition(s).

## Shared-Resource Identification

- **Shared, not owned:** the compute task + ALB, VPC/network, the choreography
  bus itself, the CloudWatch/X-Ray observability plane, the CI/CD pipeline, and
  the session/authz in-process dependencies — all Platform- or upstream-owned
  (mirrors the `unit-request-workflow` shared-infrastructure inventory). This
  unit **adds its own metrics/alarms** (ingest histogram, backlog age, query
  latency, integrity-sweep failures) onto the shared plane.
- **Owned uniquely by this unit:** the durable append-only / WORM audit store
  (C5) + its `queryTrail` secondary index, the bus subscription rule + DLQ (C2),
  the integrity-sweep job (C7), and the retention/tiering lifecycle policy (C8).
  These are the line items attributable to `unit-audit-trail` in the shared
  monolith bill (cost-allocation tags `Service=audit-trail`).
- **Single-writer guarantee:** only C1 writes the audit store, and the store
  enforces append-only at the storage layer (`security-design` SD-AUD-9) — the
  structural teeth behind the immutable-audit invariant, analogous to the
  single-writer rule on the workflow's request table.

## Handoff to Infrastructure Design

Open decisions this inventory hands forward (consistent with the Open Items in
`performance-requirements`, `scalability-requirements`, `reliability-requirements`,
and `security-requirements`):

1. Concrete durable append-only / WORM store technology for C5 (object-lock /
   retention-policy class), under the procurement gate (`tech-stack-decisions`,
   `req-constraint-build-gate`).
2. The `queryTrail` secondary-index technology and shape
   (`department`+`occurredAtMs`, filter predicates, pagination cursor).
3. Cold/aged-data tiering mechanism for C8 that preserves append-only,
   WORM, and hash-verifiability.
4. Concrete RPO/RTO, backup cadence, and durability class for C5, aligned with
   the `unit-request-workflow` store owner's shared retention posture.
5. DLQ + alerting wiring for C2 and the scheduled cadence for the C7 integrity
   sweep.
6. Whether the KMS-backed signing seam (`security-design` SD-AUD-10) is activated
   at MVP or deferred.
