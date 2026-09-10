---
consumes: [performance-design, security-design, scalability-design, reliability-design, logical-components, components, services, business-logic-model]
unit: unit-audit-trail
stage: infrastructure-design
---

# Deployment Architecture — `unit-audit-trail`

AWS deployment architecture for the **Immutable Audit Trail** unit — the
append-only compliance system-of-record for every accepted transition in the
vacation-request workflow. This design translates the unit's functional shape
(`business-logic-model` — `recordEvent` / `getRequestTrail` / `queryTrail` /
`verifyChain`), its component inventory (`logical-components` C1–C8), and its
non-functional envelope (`performance-design`, `scalability-design`,
`reliability-design`, `security-design`) into concrete AWS service selections,
network topology, and environment definitions.

The overriding constraint is **topology parity with the shipped modular
monolith**. Per `components` (modular-monolith architecture) and `services`
(audit is a *choreography side-effect consumer*, off the synchronous command
path), this unit is an **embedded in-process module** — it does **not** get its
own compute. Its Express read routes run inside the shared ECS task and its
`recordEvent` handler is a subscriber to the shared choreography bus
(`logical-components` C1/C6). What this unit *adds* to the infrastructure is the
pieces the NFR designs deliberately deferred to this stage: a **durable
append-only / WORM audit store** (C5), its **event subscription + DLQ** (C2), an
**integrity-sweep job** (C7), and the **retention/tiering lifecycle** (C8).

## Compute Model

- **No dedicated compute for the read surface.** The auditor read endpoints
  (`getRequestTrail` / `queryTrail` / `verifyChain`) run as Express routes inside
  the same **ECS Fargate** monolith task the shipped units share
  (`logical-components` LC-AUD "embedded in-process module"; parity with the
  `unit-request-workflow` deployment). This keeps the composed
  `requireSession → requirePermission → handler` guard an in-process call chain
  (`security-design` SD-AUD-1), with no new network hop.
- **Ingest consumer on the audit unit's own subscription.** The `recordEvent`
  handler (`logical-components` C1) is driven by this unit's **own SQS queue**
  fed by an **EventBridge rule** matching the five workflow `detail-type`s
  (`scalability-design` SC-AUD-1). Ingest is processed by the same Fargate task
  fleet (a poller inside the monolith) or, as a reversible alternative behind the
  same port, a dedicated **arm64 Lambda** consumer — either way stateless and
  horizontally scalable with **no affinity** (`scalability-design` SC-AUD-1/5).
  The MVP wires the in-task poller to avoid a second deployable, consistent with
  the embedded-module posture.
- **arm64 / Graviton** for any audit-owned compute (the integrity-sweep job and,
  if chosen, the ingest Lambda) — ~20% better price-performance (Well-Architected
  Cost & Sustainability).
- **Stateless everywhere** (`scalability-design` SC-AUD-1): the ingest handler
  holds no per-event state between calls and all state lives in the `AuditStore`
  behind its port, so both ingest and read scale out without coordination.

## Networking Topology

The unit inherits the shared monolith VPC — it stands up **no new network**
(`logical-components` shared-resource inventory). Its data-plane resources are
reached over private paths:

```
Shared monolith VPC (Platform-owned NetworkStack)
├── Public subnets  (AZ-a, AZ-b)   → ALB (shared)
├── Private subnets (AZ-a, AZ-b)   → ECS Fargate tasks (monolith; audit routes + ingest poller)
└── VPC endpoints                  → DynamoDB (Gateway), SQS + S3 + KMS (Interface/Gateway)
```

- **Auditor HTTP over the shared ALB**, HTTPS-only (ACM cert, TLS 1.2+),
  satisfying the in-transit half of `security-design` SD-AUD-13.
- **Data-plane traffic stays on the AWS network.** The durable store (DynamoDB),
  the WORM tier (S3), the ingest queue (SQS), and KMS are reached via **VPC
  endpoints** — no NAT cost, no public egress for evidence data
  (`security-design` SD-AUD-13 at-rest/in-transit posture; DevSecOps
  no-`0.0.0.0/0` rule).
- **Security groups** are inherited from the monolith; the audit unit adds no
  ingress rule of its own (its read routes sit behind the existing ALB→task SG).

## Storage Strategy — the durable append-only / WORM store (C5)

`tech-stack-decisions` and `business-logic-model` left the concrete production
store open behind the `AuditStore` port; this stage selects it. The access
pattern (`performance-design` PD-AUD-2/6/7, `scalability-design` SC-AUD-2/6/7) is
append-only writes, single-`requestId`-partition reads, and one corpus-scanning
`queryTrail`:

| Requirement (source) | AWS mapping |
|----------------------|-------------|
| Append one record per event, O(1) (`performance-design` PD-AUD-2/10) | DynamoDB `PutItem` with `attribute_not_exists` guard |
| Single-partition ordered read `getRequestTrail` / `verifyChain` (`performance-design` PD-AUD-6) | `Query` on `PK = REQ#<requestId>` |
| Per-`requestId` partitioning, no global chain head (`scalability-design` SC-AUD-2/6) | DynamoDB partition key `RequestId` (high-cardinality, near-one-writer) |
| `queryTrail` over the 7-year corpus ≤ 500 ms p95 (`performance-design` PD-AUD-7, `scalability-design` SC-AUD-7) | GSI: `department` (PK) + `occurredAtMs` (SK), `eventType`/`actorId` filters, cursor pagination |
| Storage-layer immutability against an operator (`security-design` SD-AUD-9) | **S3 Object Lock (COMPLIANCE mode, WORM)** as the retained-evidence tier |
| 7-year retention, no early purge (`reliability-design` RD-AUD-10, `scalability-design` SC-AUD-9) | S3 Object Lock retention = `retainUntilMs`; DynamoDB PITR; no TTL |
| Encryption at rest for pseudonymous employee data (`security-design` SD-AUD-13) | SSE-KMS on DynamoDB and S3 |

**Two-tier design intent (behind the one `AuditStore` port).** DynamoDB serves
the hot, single-key + indexed read paths and enforces append-only *at the
application/IAM layer* (no `UpdateItem`/`DeleteItem` grant on `TX#` items). S3
with **Object Lock in COMPLIANCE mode** is the storage-layer WORM tier that makes
immutability hold even against an operator with store credentials
(`security-design` SD-AUD-9) — the teeth the type-level port alone cannot
provide. Records are written to both on ingest (or projected to S3 by a
lifecycle writer); the hash chain (`security-design` SD-AUD-6) is the
cross-tier integrity proof. The **in-memory adapter stays the dev/test default**
behind the port, so `vitest` needs no AWS. Because both the store *and* the
build-vs-buy verdict are procurement-gated (`security-design` SD-AUD-9,
`req-constraint-build-gate`), this is asserted as **design intent + the seam**,
not a procured lock-in (see the open items in `logical-components` handoff).

## Environment Layout (dev / staging / prod)

Per the team `## Deployment` rule (deploy-on-merge to staging; production behind
a manual approval gate) and Well-Architected parity — environments differ only
in **scale**, never in **topology**:

| Concern | dev (local) | staging | production |
|---------|-------------|---------|------------|
| Read routes / ingest | local `node`, in-memory adapter, in-process bus | inside the shared Fargate task | inside the shared Fargate task (multi-AZ) |
| Audit store (DynamoDB) | in-memory | on-demand capacity, PITR on | provisioned + autoscaling, PITR on |
| WORM tier (S3 Object Lock) | none (in-memory) | Object Lock, GOVERNANCE (test) | Object Lock, **COMPLIANCE** (immutable) |
| Ingest transport | in-process bus | EventBridge rule → SQS + DLQ | EventBridge rule → SQS + DLQ |
| Integrity-sweep job (C7) | manual test invoke | EventBridge Scheduler (daily) | EventBridge Scheduler (daily + post-restore) |
| KMS | n/a | AWS-managed | customer-managed (rotation on) |
| Secrets | `.env` (git-ignored) | SSM / Secrets Manager | SSM / Secrets Manager |

Non-production DynamoDB uses **on-demand** capacity so idle cost is zero when
quiet; production uses provisioned + autoscaling for predictable cost under the
bounded ingest envelope (`scalability-design` SC-AUD-13). Staging uses S3 Object
Lock in **GOVERNANCE** mode so test data can be cleaned up by a privileged role;
production uses **COMPLIANCE** mode so nothing — not even root — can shorten
retention.

## Infrastructure-as-Code Approach

- **AWS CDK v2 (TypeScript)** — matches the shipped stack and the workflow unit's
  IaC choice, so infra and app code share one language and review flow.
- **Folded into the monolith's existing stacks**, not a parallel stack set
  (embedded-module posture, `logical-components` shared-resource inventory):
  - `DataStack` gains the **audit DynamoDB table + GSI** and the **S3 Object Lock
    bucket** (stateful; `removalPolicy: RETAIN` in prod).
  - `EventingStack` gains this unit's **EventBridge rule + SQS queue + DLQ** (C2).
  - `ComputeStack` gains the ingest poller wiring / optional ingest Lambda and the
    **EventBridge Scheduler** rule for the C7 integrity sweep.
  - `MonitoringStack` gains the audit alarms (see `monitoring-design`).
- **Environment-aware via CDK context** (`--context env=dev|staging|prod`), one
  codebase parameterised by a per-env config map (capacity mode, Object Lock
  mode, KMS key type) — never hardcoding account IDs or regions.
- **CDK Aspects for compliance**: a tree-wide aspect asserts the audit table has
  SSE-KMS + PITR enabled, the S3 bucket has Object Lock + `BLOCK_ALL` public
  access + versioning, no IAM policy grants `UpdateItem`/`DeleteItem` on `TX#`
  items, and required cost-allocation tags (`Service=audit-trail`) are present —
  the DevSecOps and compliance guardrails made executable.

## Resource Sizing Summary

| Resource | dev | staging | prod |
|----------|-----|---------|------|
| Audit compute | in-process | shared Fargate task | shared Fargate task (multi-AZ) |
| Audit DynamoDB + GSI | in-memory | on-demand, PITR | provisioned + autoscaling, PITR |
| S3 Object Lock (WORM) | — | GOVERNANCE | COMPLIANCE |
| SQS ingest queue + DLQ | in-process | 1 queue + 1 DLQ | 1 queue + 1 DLQ |
| Integrity-sweep schedule | manual | daily | daily + post-restore |

Sizing is deliberately conservative: ingest tracks workflow write volume 1:1
(≤ ~4 events per request, `performance-design` ingest budget) and auditor reads
are single-digit concurrency (`scalability-design` SC-AUD-4). Storage grows
**monotonically** across the 7-year window (`scalability-design` SC-AUD-9), so
the capacity worksheet — not compute — is the dominant sizing artefact; cold
tiering (see `infrastructure-services`) contains its cost.
