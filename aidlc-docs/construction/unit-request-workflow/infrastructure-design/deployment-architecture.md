# Deployment Architecture — `unit-request-workflow`

AWS deployment architecture for the **Vacation Request Workflow** unit — the
synchronous command-path core that drives the `VacationRequest` aggregate
through the two-stage approval workflow. This design translates the unit's
functional shape ([[business-logic-model]] Workflows A/B/C), its persistence and
concurrency contract ([[domain-entities]] `VacationRequestRepository`,
[[business-rules]] `BR-INV-2/3/4`), and its non-functional envelope
([[performance-design]], [[scalability-design]], [[reliability-design]],
[[security-design]]) into concrete AWS service selections, network topology, and
environment definitions.

The overriding constraint is **environment/topology parity with the shipped
modular monolith**: `unit-platform-auth`, `unit-platform-authz`, and
`unit-hris-balance` are already in the tree and deploy as one in-process
deployable ([[components]] modular-monolith architecture; [[services]] five
logical services in one deployable). This unit is an **embedded in-process
module** ([[logical-components]] ADR-WF-COMP-01 — "embedded module boundary, not
a separate service"), so it does **not** get its own compute; it ships inside
the same container and shares the network, secrets, and observability plane
established for the monolith. What this unit *adds* to the infrastructure is a
**durable append-only request store** and its **event-emission wiring** — the
pieces `tech-stack-decisions` deliberately deferred to this stage.

## Compute Model

- **Container on AWS ECS Fargate**, not per-unit Lambda. The modular monolith is
  one long-lived Node.js 20 / Express process whose hot paths assume in-process
  ports: the O(1) authz grant-table check ([[performance-design]] command-path
  authorization ≤ 5 ms), in-process session-token validation, and the
  in-process choreography event bus ([[scalability-design]] ADR-WF-SCALE-01).
  Splitting units into separate Lambdas would fragment those seams and
  re-introduce the network hops the designs explicitly avoid. One Fargate task
  definition packages the whole monolith; `unit-request-workflow` is additive
  code inside it.
- **arm64 / Graviton** task architecture for ~20% better price-performance
  (Well-Architected Cost & Sustainability pillars; cost-optimization knowledge
  "Graviton offers 20-40% better price-performance").
- **Task sizing**: baseline **0.5 vCPU / 1 GB** per task (the workload is modest,
  bursty, human-in-the-loop — [[performance-design]] "load is modest and bursty",
  ≤ 25 req/s aggregate, ≤ 50 concurrent in-flight commands). Right-size from
  Compute Optimizer after 14 days rather than over-provisioning.
- **Stateless tasks** ([[scalability-design]] "stateless app-tier horizontal
  scaling"; [[performance-design]] "the workflow service holds no per-request
  state"): all state lives in the request store behind the port, so tasks scale
  out with **no session affinity** behind the load balancer.

## Networking Topology

Single-region, **multi-AZ** VPC (Well-Architected Reliability pillar — "deploy
across at least 2 AZs for all critical components"; [[reliability-design]] 99.9%
command-path SLO):

```
VPC (10.0.0.0/16)
├── Public subnets  (AZ-a, AZ-b)   → ALB, NAT Gateway
├── Private subnets (AZ-a, AZ-b)   → ECS Fargate tasks (the monolith)
└── (no DB subnet)                 → DynamoDB reached via Gateway VPC endpoint
```

- **Application Load Balancer** in the public subnets, HTTPS-only (ACM cert,
  TLS 1.2+), terminating TLS and forwarding to Fargate tasks. Health check on
  `/health` (Well-Architected Reliability — health checks on LB targets).
- **Fargate tasks in private subnets** — no public IP; egress (IdP metadata,
  HRIS) via NAT Gateway.
- **DynamoDB via a Gateway VPC endpoint** — the request-store traffic never
  leaves the AWS network, no NAT cost for it, and the security group needs no
  DynamoDB egress rule.
- **Security groups as firewalls**: ALB SG allows 443 from the internet; task SG
  allows the app port **only from the ALB SG** (no `0.0.0.0/0` ingress — the
  DevSecOps and Well-Architected Security anti-pattern check). This satisfies the
  network half of [[security-design]] SEC-WF-8 (TLS in transit) and the
  fail-closed network posture the auth/authz units assume.

## Storage Strategy — the durable append-only request store

`tech-stack-decisions` deferred the concrete production store to this stage; the
port is `VacationRequestRepository` ([[domain-entities]]). Selection: **Amazon
DynamoDB**, because the access pattern is a precise fit:

| Requirement (source) | DynamoDB mapping |
|----------------------|------------------|
| Single-key read `findById` ([[performance-design]] ≤ 50 ms p95) | `GetItem` by partition key `RequestId` |
| Append-only history, never overwrite ([[business-rules]] `BR-INV-4`, `req-constraint-append-only-store`) | Item-per-transition (sort key `TX#<seq>`) OR an append-only `history` list; current status is a derived item attribute |
| Optimistic concurrency ([[business-rules]] `BR-INV-2/3`, [[reliability-design]] REL-WF-5) | `PutItem`/`UpdateItem` with `ConditionExpression: version = :expectedVersion` — native, lock-free |
| Same-logical-commit event ([[business-rules]] `BR-INV-5`, [[reliability-design]] REL-WF-4) | **DynamoDB Streams** as transactional outbox → EventBridge (see [[infrastructure-services]]) |
| 7-year audit feed ([[reliability-design]] REL-WF-9, `req-nfr-audit-retention`) | **Point-in-time recovery (PITR)** on the table; long-term archival owned by the `audit-trail` unit consuming the stream |
| Encryption at rest for employee PII ([[security-design]] SEC-WF-8, `req-nfr-security-pii`) | SSE with AWS-managed KMS key (minimum); customer-managed KMS if compliance requires |

The **in-memory adapter stays the dev/test default** behind the port — DynamoDB
is wired only in the deployed environments, so `vitest` runs need no AWS. This is
the same port/adapter swap the authz unit uses (in-memory → DynamoDB-backed
`RoleDirectoryPort`), keeping the seam consistent across the monolith.

## Environment Layout (dev / staging / prod)

Per the team `## Deployment` rule (deploy-on-merge to staging; production behind
a manual approval gate) and Well-Architected parity ("staging MUST use the same
IaC templates as production, parameterized for scale"):

| Concern | dev (local) | staging | production |
|---------|-------------|---------|------------|
| Compute | local `node` / docker-compose, in-memory adapters | 1 Fargate task (arm64) | 2+ Fargate tasks, multi-AZ, autoscaling |
| Request store | in-memory | DynamoDB, **on-demand** capacity, PITR on | DynamoDB, **provisioned + autoscaling**, PITR on |
| Event bus | in-process bus | EventBridge | EventBridge |
| TLS | optional (localhost) | ACM cert | ACM cert |
| Secrets | `.env` (git-ignored) | SSM/Secrets Manager | SSM/Secrets Manager |
| Scale | n/a | reduced (parity topology) | full multi-AZ |

Environments differ only in **scale**, never in **topology** (Well-Architected
Reliability + the platform-agent "environment parity prevents surprises"
principle). Non-production DynamoDB uses **on-demand** capacity so idle cost is
zero when quiet; production uses provisioned + autoscaling for predictable cost
under seasonal bursts.

## Infrastructure-as-Code Approach

- **AWS CDK v2 (TypeScript)** — matches the team's TypeScript stack (CDK
  best-practices knowledge: "recommended language for most teams"), so infra and
  application code share one language and one review flow.
- **Stack separation by lifecycle** (CDK best-practices "separate stacks by
  lifecycle; stateful resources in separate stacks from stateless"):
  - `NetworkStack` — VPC, subnets, NAT, security groups, VPC endpoint (rarely
    changes).
  - `DataStack` — the DynamoDB request table, KMS key, PITR (stateful, changes
    rarely; `removalPolicy: RETAIN` in prod).
  - `ComputeStack` — ECS cluster, Fargate service/task def, ALB, autoscaling
    (stateless, deploys frequently).
  - `EventingStack` — EventBridge bus + Streams wiring (see
    [[infrastructure-services]]).
  - `MonitoringStack` — alarms, dashboards (see [[monitoring-design]]).
- **Environment-aware via CDK context** (`--context env=dev|staging|prod`), one
  codebase parameterised by a per-env config map for task count and DynamoDB
  capacity mode — never hardcoding account IDs or regions (CDK best-practices
  rule).
- **CDK Aspects for compliance** (CDK best-practices "compliance aspects"): a
  tree-wide aspect asserts DynamoDB encryption + PITR enabled, S3/logs blocked
  from public access, no `0.0.0.0/0` ingress, and required cost-allocation tags
  present — these are the DevSecOps and compliance guardrails made executable.

Because this unit is an embedded module, its infra contribution is folded into
the monolith's existing stacks (the `DataStack` gains the request table, the
`EventingStack` gains its event rules) rather than standing up a parallel stack
set — see [[shared-infrastructure]] for the ownership boundaries.

## Resource Sizing Summary

| Resource | dev | staging | prod |
|----------|-----|---------|------|
| Fargate task (arm64) | — | 0.5 vCPU / 1 GB ×1 | 0.5 vCPU / 1 GB ×2 (min), autoscale to 4 |
| DynamoDB | in-memory | on-demand | provisioned WCU/RCU + autoscaling, PITR |
| ALB | — | 1 | 1 (multi-AZ) |
| NAT Gateway | — | 1 | 1 per AZ (HA) |

Sizing is deliberately conservative for a bursty internal LOB workload
([[performance-design]], [[scalability-design]] load projections); scale-out is
driven by the autoscaling triggers defined in [[monitoring-design]] and
confirmed against the concrete `req-nfr-concurrency` figure noted as an open
item in [[scalability-design]].
