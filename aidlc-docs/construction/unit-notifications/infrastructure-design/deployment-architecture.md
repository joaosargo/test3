# Deployment Architecture — `unit-notifications`

AWS deployment architecture for the **Notification** unit — the choreographed,
event-driven side-effect tier that turns each vacation-request state change into
an **email** and an **in-app** notification. This design translates the unit's
functional shape (`business-logic-model` — the idempotent, at-least-once
`handleEvent` pipeline and the self-scoped in-app read side) and its
non-functional envelope (`performance-design` two-path model, `scalability-design`
queue-driven stateless workers, `reliability-design` per-channel breakers +
dead-lettering, `security-design` PII containment) into concrete AWS service
selections, network topology, and environment definitions. The
component-to-infra mapping is grounded in `logical-components` (C1–C10) and the
platform grouping in `components` and `services`.

The overriding constraint is **topology parity with the shipped modular
monolith**. Per `logical-components` and the completed
`unit-request-workflow` infrastructure, `unit-platform-auth`,
`unit-platform-authz`, `unit-hris-balance`, and `unit-request-workflow` deploy as
one in-process Node.js 20 / Express deployable on ECS Fargate. This unit does
**not** stand up a parallel platform; it adds (a) a **producer-side enqueue seam**
that runs in-process on the workflow's choreography subscription, and (b) an
**async delivery tier** reachable only via a durable queue. What it *adds* to the
infrastructure is a **notification queue + dead-letter queue**, two **durable
DynamoDB stores** (in-app inbox, delivery records), an **email-provider binding**,
and its **observability wiring** — the pieces `tech-stack-decisions` (ADR-NOTIF-02
queue, ADR-NOTIF-03 email port, ADR-NOTIF-04 in-app store) deferred to this stage.

## Compute Model — two seams, one baseline

Per the two-path split in `performance-design` and the failure/service boundaries
in `logical-components`, compute is provisioned for two distinct seams:

- **Producer-side enqueue (C1)** — runs **in-process inside the existing Fargate
  monolith task**, on the workflow's choreography subscription. It does exactly
  one thing: serialize the PII-free `WorkflowEvent` and hand it to the queue port
  within the ≤3ms p95 enqueue budget (`performance-design`). It shares the
  monolith's failure domain but is guarded to never throw back into the workflow
  commit (`reliability-design` non-blocking invariant). It adds **no new compute**.

- **Async delivery worker (C3–C8)** — a **stateless, queue-driven worker**. Two
  provisioning options behind one parameterised topology, differing only in scale:
  - **MVP / low volume**: the worker runs as an **in-process consumer inside the
    same Fargate monolith task**, draining the queue on a background loop
    (topology parity, minimal moving parts). This is the `ADR-NOTIF-02` "in-proc
    MVP" realised on the shared task.
  - **Scaled**: the worker splits into a **dedicated queue-driven compute** — a
    **Lambda triggered by the SQS queue** (event-source mapping) with reserved
    concurrency, or a separate Fargate service with queue-depth autoscaling. The
    split is safe because the worker is stateless with no session affinity
    (`scalability-design`) and reachable only via the queue — no synchronous
    caller crosses into it (`logical-components` delivery boundary).

  **Selection: SQS → Lambda worker** for the delivery tier in staging/prod. Lambda
  is a natural fit for an **I/O-bound, bursty, queue-driven** workload
  (`scalability-design` — scaling keys on queue depth/age, not CPU): it scales
  with queue arrivals automatically, bills only per invocation (cost-optimisation
  for a bursty internal LOB workload), and its event-source mapping gives
  competing-consumers + visibility-timeout lease + native partial-batch reporting
  for at-least-once (`reliability-design`). The in-memory adapter stays the
  dev/test default behind the port, so `vitest` needs no AWS.

- **arm64 / Graviton** everywhere it applies (Lambda `arm64`, any Fargate task) —
  ~20% better price-performance (Well-Architected Cost & Sustainability),
  consistent with the workflow unit's compute model.

- **In-app Read API (C9)** — the `listForRecipient` / `markRead` surface is a
  small authenticated request/response path that runs **in-process in the
  monolith** behind the existing ALB and session middleware (`security-design`
  self-scoped reads); it is an independent read path (`logical-components` FD-Read)
  and adds no new compute.

## Networking Topology

The unit inherits the monolith's single-region, **multi-AZ** VPC
(`unit-request-workflow` deployment-architecture; Well-Architected Reliability —
≥2 AZs for critical components). It adds only egress paths and managed-service
endpoints:

```
VPC (shared with the monolith)
├── Public subnets  (AZ-a, AZ-b)   → ALB (in-app read path only), NAT Gateway
├── Private subnets (AZ-a, AZ-b)   → Fargate monolith task (producer C1, read C9)
│                                     Lambda worker (delivery C3–C8) in-VPC only if it
│                                     needs the directory over private networking
├── Gateway VPC endpoint           → DynamoDB (in-app inbox C6, delivery records C7)
└── Interface VPC endpoints        → SQS (queue C2 + DLQ C8), SES (email C5),
                                      Secrets Manager / SSM, KMS (crypto C10)
```

- **Queue and DLQ (C2/C8)** are Amazon SQS, reached via an **SQS interface VPC
  endpoint** so producer→queue and worker←queue traffic stays on the AWS network.
- **Email (C5)** is Amazon SES via an **SES interface VPC endpoint**; outbound to
  the provider is TLS (`security-design` encryption-in-transit table).
- **DynamoDB (C6/C7)** via the shared **Gateway VPC endpoint** — no NAT cost, no
  DynamoDB egress rule needed (matching the workflow unit's storage networking).
- **Directory reads (C4)** to the IdP/HRIS/internal directory use the same egress
  path the platform auth/HRIS units already use (NAT for external IdP; in-VPC for
  an internal directory) — the concrete source is an open item (see `memory.md`).
- **Security groups as firewalls**: the Lambda/worker SG allows only the egress it
  needs (SQS, DynamoDB, SES, KMS, directory); **no `0.0.0.0/0` ingress** anywhere
  (Well-Architected Security anti-pattern check; DevSecOps guardrail). The in-app
  read path reuses the monolith's ALB→task SG (443 from internet to ALB; app port
  only from the ALB SG).

## Storage Strategy — two durable DynamoDB stores

`tech-stack-decisions` (ADR-NOTIF-04) left the concrete in-app store open; the
delivery-record store is required by `reliability-design` for idempotency and
dead-letter reconciliation. Both are **Amazon DynamoDB**, matching the platform's
existing DynamoDB + KMS + PITR posture and the O(1)/keyed access patterns in
`performance-design` and `scalability-design`:

| Store (component) | Requirement (source) | DynamoDB mapping |
|-------------------|----------------------|------------------|
| **In-app inbox (C6)** `notifications-inapp-<env>` | Self-scoped per-principal reads, paginated (`scalability-design` indexed `(recipientId, read, createdAtMs)`; `security-design` self-scope) | `PK = RCPT#<recipientId>`, `SK = NOTIF#<createdAtMs>#<notificationId>`; GSI or SK-prefix filter for `unreadOnly` |
| In-app inbox — PII bodies (`security-design` BR-PII-3) | Field-level encryption of `title`/`body` via `CryptoPort` (C10); fail-closed if crypto unavailable | Application-side field encryption (KMS-backed) before `PutItem`; SSE-at-rest as defense-in-depth |
| In-app inbox — bounded growth (`scalability-design`) | Bounded retention window (TBD compliance) | **DynamoDB TTL** attribute `expireAt` (e.g. 90d after read/aged) prunes automatically at no write cost |
| **Delivery records (C7)** `notifications-delivery-<env>` | Append-only; O(1) idempotency lookup on `(recipientId, dedupeKey)` (`performance-design`, `reliability-design` BR-NOTIF-9/11) | `PK = RCPT#<recipientId>`, `SK = DK#<dedupeKey>`; `GetItem` is the dedupe guard; write-once items |
| Delivery records — append-only integrity (`reliability-design` BR-NOTIF-11; `security-design` STRIDE-Tampering) | No mutation of a recorded outcome | IAM policy + CDK aspect forbid `UpdateItem`/`DeleteItem`; only `PutItem`/`GetItem`/`Query` granted |
| Delivery records — bounded (`scalability-design`) | Outlive the redelivery window, then archive/prune | **DynamoDB TTL** (e.g. 30d ≥ redelivery window); distinct from the 7-year `audit-trail` retention this unit does NOT own |
| Both stores — PII/at-rest (`security-design`) | Encryption at rest | SSE with KMS (AWS-managed minimum; customer-managed if compliance dictates) |

- **DynamoDB TTL is used here** (unlike the workflow request store, which
  deliberately does not) because notification/delivery data is intentionally
  bounded, not the permanent system of record — the retention distinction
  `scalability-design` and `security-design` both call out.
- The **in-memory adapters stay the dev/test default** behind `InAppInboxPort` and
  `NotificationDeliveryRepository`; DynamoDB is wired only in deployed
  environments, the same port/adapter swap the platform units use.

## Environment Layout (dev / staging / prod)

Per the team `## Deployment` rule (deploy-on-merge to staging; production behind a
manual approval gate) and Well-Architected parity ("staging MUST use the same IaC
templates as production, parameterized for scale"):

| Concern | dev (local) | staging | production |
|---------|-------------|---------|------------|
| Producer C1 | in-process, in-memory publisher | in-process in monolith task | in-process in monolith task |
| Queue C2 / DLQ C8 | in-process queue | SQS standard + SQS DLQ | SQS standard + SQS DLQ |
| Worker C3 | in-process loop, in-memory adapters | SQS→Lambda (arm64), low reserved concurrency | SQS→Lambda (arm64), autoscaled reserved concurrency |
| Email C5 | in-memory recorder | SES (sandbox or verified domain) | SES verified domain + DKIM |
| In-app store C6 | in-memory | DynamoDB, on-demand, TTL on, PITR on | DynamoDB, provisioned + autoscaling, TTL on, PITR on |
| Delivery store C7 | in-memory | DynamoDB, on-demand, TTL on | DynamoDB, provisioned + autoscaling, TTL on |
| Directory C4 | stub resolver | read-through to IdP/directory + in-proc cache | read-through to IdP/directory + in-proc cache |
| Secrets | `.env` (git-ignored) | SSM / Secrets Manager | SSM / Secrets Manager |
| Scale | n/a | reduced (parity topology) | full multi-AZ |

Environments differ only in **scale**, never in **topology** (Well-Architected
Reliability; platform-agent "environment parity prevents surprises"). Non-prod
DynamoDB and Lambda use on-demand/low-concurrency for near-zero idle cost on a
bursty workload; prod uses provisioned + autoscaling.

## Infrastructure-as-Code Approach

- **AWS CDK v2 (TypeScript)** — matches the team stack and the workflow unit's
  IaC, so infra and application code share one language and review flow.
- **Stack contribution, not a parallel stack set.** Because this unit is an
  embedded module, its infra folds into the monolith's existing lifecycle-separated
  stacks (CDK best-practices "stateful resources in separate stacks from
  stateless"):
  - `DataStack` gains the two DynamoDB tables (`notifications-inapp-<env>`,
    `notifications-delivery-<env>`) + their KMS/PITR/TTL config — stateful,
    `removalPolicy: RETAIN` in prod.
  - a `NotificationStack` (stateless) adds the SQS queue + DLQ, the EventBridge
    rule that routes the five workflow `detail-type`s into the queue, the
    SQS→Lambda worker (or the worker's background wiring in the MVP), and the SES
    binding.
  - `MonitoringStack` gains this unit's alarms/dashboards (see `monitoring-design`).
- **Environment-aware via CDK context** (`--context env=dev|staging|prod`), one
  codebase parameterised by a per-env config map (queue redrive maxReceiveCount,
  Lambda reserved concurrency, DynamoDB capacity mode, TTL windows) — never
  hardcoding account IDs or regions.
- **CDK Aspects for compliance**: a tree-wide aspect asserts both tables have
  encryption + PITR enabled, the delivery table forbids update/delete (append-only,
  `security-design`), SQS queues are encrypted (SSE-SQS/KMS), no SG allows
  `0.0.0.0/0` ingress, and required cost-allocation tags are present — the
  DevSecOps and compliance guardrails made executable.

## Resource Sizing Summary

| Resource | dev | staging | prod |
|----------|-----|---------|------|
| Producer C1 | in-process | in-process (no added compute) | in-process (no added compute) |
| Worker C3 (Lambda arm64) | in-process | 256–512 MB, low reserved concurrency | 512 MB (Power-Tuning-verified), reserved concurrency sized to `worker_count × per_worker_concurrency` bounded provider budget |
| SQS queue C2 / DLQ C8 | in-process | standard queue + DLQ, `maxReceiveCount=3` (matches retry policy) | standard queue + DLQ, `maxReceiveCount=3`, long-poll |
| DynamoDB C6/C7 | in-memory | on-demand, TTL, PITR | provisioned + autoscaling, TTL, PITR |
| SES C5 | in-memory | sandbox/verified | verified domain + DKIM, dedicated pool optional |

Sizing is deliberately conservative for a bursty internal LOB workload
(`performance-design`, `scalability-design` ~500 concurrent users); Lambda memory
is confirmed with Power Tuning and reserved concurrency is the primary knob that
enforces the bounded-provider-connection budget (`scalability-design`
DoS-containment). Scale-out is driven by queue-depth/age triggers defined in
`monitoring-design`.
