# Deployment Architecture — `unit-sla-escalation`

AWS deployment architecture for the **SLA Reminder and Escalation** unit — the
**timer-driven** side-effect that watches vacation requests sitting too long in a
pending stage and fires reminder / escalation notices. This design translates the
unit's functional shape (`business-logic-model` — the idempotent
`runScanTick` scan pipeline, the read-only pending query, and the append-only
reminder ledger) and its non-functional envelope (`performance-design` bounded
per-tick batch work; `scalability-design` single stateless scanner first;
`reliability-design` at-most-once + catch-up self-healing; `security-design`
least-privilege read-only principal + PII containment) into concrete AWS service
selections, network topology, and environment definitions. The
component-to-infra mapping is grounded in `logical-components` (C1–C9) and the
platform grouping in `components` and `services`.

The overriding constraint — as with every shipped unit — is **topology parity
with the modular monolith**. Per `components` and `services` and the completed
`unit-request-workflow` / `unit-notifications` infrastructure,
`unit-platform-auth`, `unit-platform-authz`, `unit-hris-balance`,
`unit-request-workflow`, and `unit-notifications` deploy as one in-process
Node.js 20 / Express deployable on ECS Fargate. This unit does **not** stand up a
parallel platform. What it *adds* is exactly two infrastructure pieces that
`tech-stack-decisions` deferred to this stage: a **scheduler binding** (for the
`SchedulerPort`, component C1) and a **durable append-only reminder ledger** (for
`ReminderLedgerRepository`, component C6). Everything else — the scan compute, the
workflow read, the recipient directory, and the dispatch transport — reuses
in-process seams or upstream units' shared infrastructure.

## Compute Model — the scanner is a scheduled invocation, not a service

Per `logical-components` (C1 Scheduler Trigger, C2 Scan Orchestrator, C3 pure
Evaluator) and `scalability-design` ("single stateless scanner first, scale by
cadence before instances"), compute is provisioned for a **background scan**, not
a request-serving tier. There is no synchronous caller and no user waits on a tick
(`performance-design`).

Two provisioning options behind the one `SchedulerPort` contract, differing only
in scale:

- **MVP / baseline volume — in-process scheduled scan inside the monolith task.**
  An **EventBridge Scheduler** schedule (see below) invokes `runScanTick(nowMs)` in
  the existing Fargate monolith task on the cadence (placeholder **15 min**,
  `performance-design` / `scalability-design`). At tens-to-low-hundreds of pending
  requests per tick, a single instance completes the tick well inside the ≤ 30 s
  wall-clock budget (`performance-design`), so this is the default. It adds **no
  new compute** — the scan is a module inside the shared task, exactly the
  `ADR`-style "embedded module" posture the workflow unit uses.

- **Scaled — dedicated scheduled scan Lambda.** If the pending set ever outgrows
  the in-task budget at a tightened cadence, the scan splits into a **standalone
  Lambda** invoked directly by an **EventBridge Scheduler** schedule (a scheduled
  invocation, **not** an SQS-triggered worker — this unit fires on the *absence* of
  an event, so there is no queue in front of the scan; `tech-stack-decisions`
  rejected a broker-driven design). The split is safe because the scanner is
  **stateless with no warm-up** (`scalability-design`, `reliability-design`
  REL-DES-9) and all durable state is the reminder ledger. Horizontal fan-out
  partitions by `department` with **no distributed locking** — the ledger dedupe
  key makes overlapping scanners safe (`scalability-design`; `reliability-design`
  REL-DES-4).

- **Selection: in-process scheduled scan for MVP staging/prod; scheduled Lambda is
  the designed-in-but-not-activated scale path.** This mirrors the notification
  unit's "in-proc MVP → dedicated compute when scaled" ladder, but with a
  **scheduler** trigger rather than a queue trigger, because the trigger is *time*,
  not an event.

- **arm64 / Graviton** wherever it applies (any scan Lambda runs `arm64`; the
  Fargate task is already arm64) — ~20 % better price-performance (Well-Architected
  Cost & Sustainability), consistent with the workflow and notification units.

- **Optional Debug Read (C9)** — the guarded single-request `evaluate` status read
  runs **in-process in the monolith** behind the existing ALB and
  `requireSession → requirePermission` seam (`security-design` SEC-DES-4). It is
  not on the scan path and adds no new compute.

## Scheduler Binding (component C1)

`tech-stack-decisions` (Scheduling) and `logical-components` (hand-off item 1)
deferred the concrete production scheduler to this stage. Decision:

- **Amazon EventBridge Scheduler** (a one-time/recurring managed scheduler),
  `rate(15 minutes)` at baseline, targeting either the monolith task's scan entry
  (MVP, via a small invoke path) or the scan Lambda (scaled). EventBridge Scheduler
  is chosen over a Fargate-internal `setInterval` timer because it is
  **durable and externally observable** — a missed schedule is visible as a metric,
  which is the *primary reliability signal* for this unit (`reliability-design`
  "missed-cadence alerting is the primary reliability signal"). An in-process
  interval would make a silently-dead scanner invisible, the exact failure mode the
  reliability design flags as the main risk.
- **Least-privilege scheduler principal** (`security-design` SEC-DES-1): the
  schedule's IAM role may invoke only the scan target — nothing else. The cadence
  value is environment config (CDK context), not code.
- **Idempotent under double-fire** (`reliability-design` REL-DES-4): a replayed or
  duplicate schedule trigger is harmless because the ledger key dedupes; the
  schedule does not need exactly-once semantics.
- The **in-process interval / manual `runScanTick`** stays the dev/test binding
  behind `SchedulerPort` — `vitest` drives ticks with an injected clock and needs
  no AWS (`tech-stack-decisions`).

## Networking Topology

The unit inherits the monolith's single-region, **multi-AZ** VPC
(`unit-request-workflow` deployment; Well-Architected Reliability — ≥ 2 AZs). It
adds only the endpoints the ledger and scheduler need; it introduces **no new
ingress** (there is no inbound request path on the scan — the trigger is a
scheduler, `security-design` SEC-DES-1).

```
VPC (shared with the monolith)
├── Public subnets  (AZ-a, AZ-b)   → ALB (debug read C9 only), NAT Gateway
├── Private subnets (AZ-a, AZ-b)   → Fargate monolith task (scan C2/C3, debug C9)
│                                     scan Lambda (scaled path) in private subnets
├── Gateway VPC endpoint           → DynamoDB (reminder ledger C6)
└── Interface VPC endpoints        → Secrets Manager / SSM, KMS
                                      (scheduler is an AWS-managed control-plane trigger)
```

- **Reminder ledger (C6)** is Amazon DynamoDB reached via the shared **Gateway VPC
  endpoint** — no NAT cost, matching the workflow/notification storage networking.
- **Workflow pending read (C5)** is an **in-process, read-only** call against the
  workflow's existing scoped read (`business-logic-model` Pending-request read;
  `logical-components` C5) — no network hop, no new endpoint. It maps onto the
  workflow repository's `findByDepartmentAndStatus`.
- **Recipient directory (C7) and dispatch transport (C8)** are the **reused
  `unit-notifications` seams** (`RecipientDirectoryPort`, `EmailSenderPort` /
  `InAppInboxPort`) — this unit adds no SES/SQS binding of its own; delivery
  reliability (retry/DLQ/breaker) lives in `unit-notifications` (`BR-SLA-12`;
  `logical-components` C7/C8).
- **Security groups as firewalls**: any scan-Lambda SG allows only the egress it
  needs (DynamoDB, KMS, Secrets Manager, and — in-VPC — the directory/workflow read
  path); **no `0.0.0.0/0` ingress** anywhere (Well-Architected Security
  anti-pattern; DevSecOps guardrail). The debug read reuses the monolith's
  ALB→task SG.

## Storage Strategy — one durable DynamoDB table (the reminder ledger)

`tech-stack-decisions` (Persistence) committed to the append-only
`ReminderLedgerRepository` port and deferred the concrete store here. Decision:
**Amazon DynamoDB**, matching the platform's DynamoDB + KMS + PITR posture and the
single-key access pattern in `performance-design` (`hasFired` p95 ≤ 20 ms) and
`scalability-design` (linear, bounded-per-request growth). Full schema in
`infrastructure-services`; deployment-relevant properties:

| Concern | Decision | Source |
|---------|----------|--------|
| Table | `sla-reminder-ledger-<env>` | `logical-components` C6 |
| Key | `PK = REQ#<requestId>`, `SK = STAGE#<stage>#TIER#<tier>` — the composite `(requestId, stage, tier)` idempotency key | `business-logic-model`; `reliability-design` REL-DES-4 |
| Access | `hasFired` = `GetItem` (single-key); `record` = `PutItem` (write-once) | `performance-design` |
| Append-only | IAM + CDK aspect forbid `UpdateItem`/`DeleteItem` | `security-design` SEC-DES-9 |
| Encryption | SSE with KMS (at-rest); PII-free by construction so exposure is minimal | `security-design` SEC-DES-6/7 |
| Retention | **DynamoDB TTL** on an `expireAt` attribute — an **operational** horizon (e.g. 90 d after terminal), explicitly **not** the 7-year audit window | `scalability-design`; `reliability-design` REL-DES-12 |
| Durability | PITR on (prod) — survives restart so at-most-once holds across recovery | `reliability-design` REL-DES-10 |

- **TTL is used here** (like the notification stores, unlike the workflow request
  store) because the ledger is an **operational** decision trail, not the permanent
  system of record — the retention distinction `scalability-design` and
  `reliability-design` both call out. Compliance evidence lives in the
  `unit-audit-trail`, not here.
- The **in-memory adapter stays the dev/test default** behind
  `ReminderLedgerRepository`; DynamoDB is wired only in deployed environments — the
  same port/adapter swap every shipped unit uses.

## Environment Layout (dev / staging / prod)

Per the team `## Deployment` rule (deploy-on-merge to staging; production behind a
manual approval gate) and Well-Architected parity ("staging MUST use the same IaC
templates as production, parameterized for scale"):

| Concern | dev (local) | staging | production |
|---------|-------------|---------|------------|
| Scheduler C1 | in-process interval / manual tick | EventBridge Scheduler `rate(15 min)` | EventBridge Scheduler `rate(15 min)` |
| Scan compute C2/C3 | in-process, injected clock | in-process in monolith task | in-process in monolith task (scan Lambda is the scale path) |
| Reminder ledger C6 | in-memory | DynamoDB, on-demand, TTL on, PITR on | DynamoDB, on-demand or provisioned+autoscaling, TTL on, PITR on |
| Workflow read C5 | stub / in-memory workflow | in-process read-only | in-process read-only |
| Directory C7 / dispatch C8 | in-memory notifications adapters | reused `unit-notifications` seams | reused `unit-notifications` seams |
| Escalation policy | in-code default (`BR-SLA-4a`) | SSM param, fail-closed at load | SSM param, fail-closed at load |
| Secrets | `.env` (git-ignored) | SSM / Secrets Manager | SSM / Secrets Manager |
| Scale | n/a | reduced (parity topology) | full multi-AZ |

Environments differ only in **scale**, never in **topology** (Well-Architected
Reliability; platform-agent "environment parity prevents surprises"). Non-prod
DynamoDB uses on-demand for near-zero idle cost on a low-write workload (ledger
writes occur only on threshold crossings, `scalability-design`).

## Infrastructure-as-Code Approach

- **AWS CDK v2 (TypeScript)** — matches the team stack and the workflow /
  notification units' IaC, so infra and application code share one language and
  review flow.
- **Stack contribution, not a parallel stack set.** Because this unit is an
  embedded module, its infra folds into the monolith's existing lifecycle-separated
  stacks (CDK best-practice "stateful resources in separate stacks from
  stateless"):
  - `DataStack` gains the `sla-reminder-ledger-<env>` DynamoDB table + its
    KMS/PITR/TTL config — stateful, `removalPolicy: RETAIN` in prod.
  - an `SlaEscalationStack` (stateless) adds the **EventBridge Scheduler** schedule
    and its least-privilege invoke role (and, on the scale path, the scan Lambda).
  - `MonitoringStack` gains this unit's alarms/dashboards — above all the
    **missed-cadence alarm** (see `monitoring-design`).
- **Environment-aware via CDK context** (`--context env=dev|staging|prod`), one
  codebase parameterised by a per-env config map (scan cadence, DynamoDB capacity
  mode, TTL window, scan-Lambda memory/concurrency when activated) — never
  hardcoding account IDs or regions.
- **CDK Aspects for compliance**: a tree-wide aspect asserts the ledger table has
  encryption + PITR enabled and forbids `UpdateItem`/`DeleteItem` (append-only,
  `security-design` SEC-DES-9), the scheduler role is least-privilege
  (`security-design` SEC-DES-1), no SG allows `0.0.0.0/0` ingress, and required
  cost-allocation tags are present — the DevSecOps and compliance guardrails made
  executable.

## Resource Sizing Summary

| Resource | dev | staging | prod |
|----------|-----|---------|------|
| Scheduler C1 | in-process | EventBridge Scheduler `rate(15 min)` | EventBridge Scheduler `rate(15 min)`, cadence tunable-to-overlap by ≤ 30 s tick budget |
| Scan C2/C3 | in-process | in-process (no added compute) | in-process (no added compute); scan Lambda arm64 256–512 MB only if activated |
| Reminder ledger C6 | in-memory | DynamoDB on-demand, TTL, PITR | DynamoDB on-demand (or provisioned+autoscaling if write rate warrants), TTL, PITR |
| Debug read C9 | in-process | in-process behind ALB | in-process behind ALB |

Sizing is deliberately minimal: this is a low-frequency background scan over a
small pending set (`performance-design`, `scalability-design` ~ tens–low-hundreds
pending), with near-zero steady-state dispatch (only newly-crossed thresholds
fire). The primary scaling knob is the **cadence**, tightened before any instance
is added (`scalability-design` scaling triggers). Scale-out (partitioned scan
Lambdas) is designed-in but not activated at MVP.
