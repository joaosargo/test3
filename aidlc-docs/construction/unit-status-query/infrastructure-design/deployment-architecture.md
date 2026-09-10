# Deployment Architecture — `unit-status-query`

AWS deployment architecture for the **Status Tracking & Query** unit — the
read/query half of the vacation-request modular monolith. This design translates
the unit's read-only functional shape (`business-logic-model` guarded-read
flows), its stateless component inventory (`logical-components`), and its
non-functional envelope (`performance-design`, `scalability-design`,
`reliability-design`, `security-design`) into concrete AWS deployment decisions.

The defining fact, carried verbatim from the `logical-components` handoff, is that
this unit **owns no infrastructure of its own** — no compute, no store, no queue,
no bus, no secrets. It is an **embedded in-process module** of the same modular
monolith (`components` modular-monolith architecture; `services` five logical
services in one deployable) that already ships `unit-platform-auth`,
`unit-platform-authz`, `unit-hris-balance`, and `unit-request-workflow`. Its
deployment contribution is therefore **additive code inside the existing task**
plus a read-only IAM grant and (conditionally) one secondary index — nothing that
stands up a parallel stack. This is the smallest deployment footprint of any unit
in the monolith, matching its smallest-blast-radius profile in
`logical-components` (LC-5).

## Compute Model

- **Shares the existing ECS Fargate task; adds no compute.** Per
  `scalability-design` SCALE-D-1, `StatusQueryService` runs as in-process code
  inside the shared Node.js 20 / Express Fargate task the monolith already
  deploys (`unit-request-workflow` `deployment-architecture` compute model). The
  three guarded reads compose `requireSession → requirePermission → handler`
  in-process, so — exactly as `business-logic-model` (Data Flow) requires — there
  is **no network hop** for auth or authz and no separate service to size.
- **arm64 / Graviton inherited.** The task architecture is arm64/Graviton for
  ~20% better price-performance (Well-Architected Cost & Sustainability),
  inherited from the monolith; this unit adds no per-architecture concern.
- **No task-size increase attributable to this unit.** The read projection is
  O(1)-in-transitions CPU with no worker offload (`performance-design` PERF-D-9,
  PERF-D-1), so the read surface consumes shared CPU and the shared store
  connection pool (`performance-design` PERF-D-7) rather than warranting a larger
  task. The baseline 0.5 vCPU / 1 GB task the workflow unit sized absorbs it;
  right-sizing stays a monolith-level decision from Compute Optimizer.
- **Stateless tasks, no session affinity.** `StatusQueryService` holds no
  per-request state between calls (`performance-design` PERF-D-11;
  `scalability-design` SCALE-D-1), so read traffic distributes across
  interchangeable tasks with no sticky routing (`scalability-design` SCALE-D-4).

## Networking Topology

The unit introduces **no new network element** — it mounts on the monolith's
existing single-region, multi-AZ VPC (`unit-request-workflow`
`deployment-architecture` networking; Well-Architected Reliability multi-AZ):

```
VPC (10.0.0.0/16)  [platform-owned, shared]
├── Public subnets  (AZ-a, AZ-b)   → ALB (HTTPS-only, TLS 1.2+)
├── Private subnets (AZ-a, AZ-b)   → ECS Fargate tasks (the monolith,
│                                      incl. this unit's read routes)
└── (no DB subnet)                 → DynamoDB via Gateway VPC endpoint
```

- **ALB mount point only.** The status-query router mounts on the shared
  Application Load Balancer that already fronts the monolith; read routes are new
  path prefixes on the same listener, not a new load balancer
  (`logical-components` "a mount point on the shared ALB/router"). TLS is
  terminated at the ALB (`security-design` SEC-D-10).
- **DynamoDB reached via the existing Gateway VPC endpoint.** The read path
  (`Query`/`GetItem`) uses the same Gateway VPC endpoint the workflow unit
  established, so read traffic never leaves the AWS network and needs no NAT and
  no new security-group egress rule.
- **No new security group.** Task ingress remains ALB-SG-only (no `0.0.0.0/0` —
  the DevSecOps and Well-Architected Security anti-pattern check), inherited from
  the monolith; this unit opens no port and adds no egress destination beyond the
  already-permitted DynamoDB endpoint.

## Storage Strategy

- **No storage owned.** Per `logical-components` (LC-5, Shared Resource
  Identification) and `security-design` (SEC-D-10), this unit persists nothing and
  holds no store credential; it reads the workflow-owned `vacation-requests-<env>`
  DynamoDB table through the shared `VacationRequestRepository` port read-only.
  There is therefore **no new at-rest encryption surface** — at-rest SSE/KMS and
  PITR on the request table are owned by `unit-request-workflow`.
- **Read-only least-privilege grant is the only "storage" addition.** The single
  infrastructure change this unit's read path requires is a Fargate task-role IAM
  grant of `dynamodb:GetItem` / `dynamodb:Query` on the `vacation-requests-<env>`
  table **and** (when built) its `(department, status)` secondary index — never
  `PutItem`/`UpdateItem`/`DeleteItem` (`security-design` SEC-D-5; SEC-D-8;
  `scalability-design` SCALE-D-7). This read-only grant is what preserves the
  single-writer append-only invariant across the read/command split
  (`logical-components` LC-11).
- **`(department, status)` GSI — conditional.** The scoped-queue read
  (`findByDepartmentAndStatus`) is the one access pattern whose cost grows with
  department size; `scalability-design` SCALE-D-7 specifies a GSI keyed on
  `(department, status)` so the queue read is a bounded `Query`, never a scan. The
  GSI is provisioned **on the workflow-owned table** (this unit cannot create it),
  and this unit's grant on it stays read-only. Whether to build it at MVP or defer
  until the queue read is measured hot is the decision recorded in
  `infrastructure-services` and the memory diary.
- **In-memory adapter stays the dev/test default.** Behind the same port, dev and
  `vitest` runs use the in-memory adapter (`scalability-design` SCALE-D-1 shared
  posture) — no AWS needed for tests, consistent with the monolith's port/adapter
  swap.

## Environment Layout (dev / staging / prod)

Environments differ only in **scale**, never in **topology** (Well-Architected
Reliability; platform-agent "environment parity prevents surprises"). Because this
unit is embedded code, its per-environment story is entirely inherited — it adds
no environment-specific resource:

| Concern | dev (local) | staging | production |
|---------|-------------|---------|------------|
| Compute | local `node` / docker-compose, in-memory adapter | shared monolith Fargate task (arm64) | shared monolith Fargate tasks, multi-AZ, autoscaling |
| Read source | in-memory request store | workflow `vacation-requests-staging` (read-only grant) | workflow `vacation-requests-prod` (read-only grant) |
| `(department,status)` GSI | n/a (in-memory scan) | present iff workflow builds it | present iff workflow builds it |
| Routes | mounted on local Express | mounted on shared ALB listener | mounted on shared ALB listener |
| Metrics | console | shared CloudWatch/X-Ray plane | shared CloudWatch/X-Ray plane |
| Scale | n/a | reduced (parity topology) | full multi-AZ |

The read path scales in lockstep with the monolith task count
(`scalability-design` SCALE-D-9 — "status-query does not scale independently of
its host"); there is no independent per-environment autoscaling policy for this
unit.

## Infrastructure-as-Code Approach

- **AWS CDK v2 (TypeScript)**, folded into the monolith's existing stacks — this
  unit stands up **no new stack** (`unit-request-workflow` `deployment-architecture`
  IaC approach; CDK best-practices "stack separation by lifecycle"):
  - `DataStack` — gains this unit's **read-only IAM grant** on the request table,
    and (conditionally) the `(department, status)` GSI definition. The table and
    GSI belong to the workflow unit's ownership boundary (`shared-infrastructure`);
    this unit contributes only the grant.
  - `ComputeStack` — gains the status-query router registration on the existing
    Fargate service; no task-definition change beyond the additive code and the
    read-only role statement.
  - `MonitoringStack` — gains this unit's per-operation latency metrics/alarms
    (`monitoring-design`).
- **Environment-aware via CDK context** (`--context env=dev|staging|prod`), reusing
  the monolith's per-env config map — never hardcoding account IDs or regions (CDK
  best-practices rule).
- **CDK Aspects enforce the read-only boundary.** A tree-wide aspect asserts this
  unit's task-role statement contains **no** `dynamodb:PutItem`/`UpdateItem`/
  `DeleteItem`/`dynamodb:*` on the request table — the executable form of the
  least-privilege read grant (`security-design` SEC-D-5; `logical-components`
  LC-11) — alongside the inherited encryption/PITR/no-public-ingress and
  cost-allocation-tag assertions.

## Resource Sizing Summary

| Resource | dev | staging | prod | Owner |
|----------|-----|---------|------|-------|
| Compute (Fargate task) | in-memory | shared monolith task | shared monolith tasks | Platform / monolith |
| Request-store read grant (IAM) | — | `GetItem`/`Query` read-only | `GetItem`/`Query` read-only | **This unit (grant)** |
| `(department,status)` GSI | in-memory | conditional (workflow table) | conditional (workflow table) | `unit-request-workflow` (table owner) |
| ALB | — | shared listener path | shared listener path | Platform / monolith |
| Observability | console | shared CloudWatch/X-Ray | shared CloudWatch/X-Ray | Platform (shared) |

This unit adds **zero standalone provisioned resources** at MVP; its entire
deployment footprint is a read-only IAM statement, a router mount, and metric
wiring — with the `(department, status)` GSI as the single conditional item,
decided against the concrete `req-nfr-concurrency` figure per the
`scalability-design` open items.
