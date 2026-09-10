---
consumes: [performance-design, security-design, scalability-design, reliability-design, logical-components, components, services, business-logic-model]
unit: unit-audit-trail
stage: infrastructure-design
---

# Shared Infrastructure — `unit-audit-trail`

This unit is one **embedded in-process module** of a modular monolith
(`logical-components` embedded-module boundary; `components` modular-monolith
architecture; `services` — audit is a choreography side-effect consumer in one
deployable). It therefore **shares** most of its infrastructure with the
already-shipped units (`unit-platform-auth`, `unit-platform-authz`,
`unit-hris-balance`) and its event-source dependency (`unit-request-workflow`).
This document draws the **ownership and access boundaries** so shared resources
have a single owner and this unit's blast radius stays contained
(`logical-components` FD-1…FD-5; `reliability-design` blast-radius note). It
aligns deliberately with the `unit-request-workflow` shared-infrastructure
inventory so the two sides of the event contract agree.

## Shared vs Owned — inventory

| Resource | Owner | This unit's relationship | Source |
|----------|-------|--------------------------|--------|
| ECS Fargate cluster + task/service + ALB + VPC | Platform (monolith) | **Shares** — audit read routes + ingest poller run as in-process code in the same task | `deployment-architecture`; `components` |
| VPC, subnets, security groups, NAT, VPC endpoints | Platform (`NetworkStack`) | **Shares** | `deployment-architecture` |
| Session / revocation store | `unit-platform-auth` | **Consumes** (in-process session validation) read-only, on the read surface | `services`; `security-design` SD-AUD-1 |
| Authz PDP + role/department directory | `unit-platform-authz` | **Consumes** via `requirePermission` in-process; never reads the directory table directly | `security-design` SD-AUD-1/2 |
| EventBridge choreography bus | Platform / published-to by `unit-request-workflow` | **Subscribes** to the 5 workflow `detail-type`s; **publishes nothing** | `services`; `logical-components` LC-AUD-1 |
| **`audit-trail-<env>` table (DynamoDB) + `GSI-Dept`** | **`unit-audit-trail` (this unit)** | **Owns** | `infrastructure-services`; `logical-components` C5 |
| **`audit-trail-worm-<env>` S3 Object Lock bucket** | **This unit** | **Owns** — the WORM evidence tier | `infrastructure-services`; `security-design` SD-AUD-9 |
| **`audit-ingest-<env>` SQS queue + DLQ + EventBridge rule** | **This unit** | **Owns** the subscription + buffer + dead-letter | `infrastructure-services`; `logical-components` C2 |
| **Integrity-sweep schedule + retention/tiering lifecycle** | **This unit** | **Owns** (C7/C8) | `infrastructure-services`; `logical-components` C7/C8 |
| CloudWatch/X-Ray observability plane | Platform | **Shares**; adds its own metrics/alarms | `monitoring-design` |
| CI/CD pipeline (CodePipeline/CodeBuild) | Platform | **Shares** the single monolith pipeline | `cicd-pipeline` |
| Secrets / SSM parameters | Platform + per-unit namespaces | **Owns** its `audit-trail/*` params | `infrastructure-services`; `security-design` SD-AUD-14 |

## Ownership rule: the audit store is this unit's, and only this unit's

The `audit-trail-<env>` DynamoDB table and `audit-trail-worm-<env>` S3 bucket are
**written exclusively by this unit's ingest handler** (`logical-components` C1
single-writer; `business-logic-model` `recordEvent`). No other unit writes them,
and this unit writes no other unit's store:

- Only **C1 `recordEvent`** appends; the store enforces append-only at the
  storage layer — the DynamoDB IAM policy forbids `UpdateItem`/`DeleteItem` on
  `TX#` items and the S3 bucket uses **Object Lock (COMPLIANCE)** so retention
  cannot be shortened even with credentials (`security-design` SD-AUD-9;
  `logical-components` "single-writer guarantee"). This is the structural teeth
  behind the immutable-audit invariant, analogous to the single-writer rule on
  the workflow's request table.
- This unit has **no access to the workflow's request table** — it receives
  **events**, never table access (`services` choreography; `logical-components`
  LC-AUD-1 "cross-unit references by id, not object graph").

## Cross-unit event contract (the shared bus)

The shared EventBridge bus is the **only** coupling point between this unit and
its source (`logical-components` LC-AUD-1; mirrors the workflow unit's published
contract):

- **`unit-request-workflow` publishes** `RequestSubmitted`, `RequestValidated`,
  `RequestApproved`, `RequestRejected`, `RequestWithdrawn` — PII-free, keyed by
  `requestId`/`ownerId`/`department` (`security-design` SD-AUD-11).
- **This unit subscribes** with its **own EventBridge rule** (matching only those
  5 `detail-type`s), its **own SQS queue**, and its **own DLQ + retry policy**
  (`infrastructure-services`; `logical-components` C2). A slow or failed audit
  sink **never back-pressures the workflow command path** (`reliability-design`
  RD-AUD-3; `performance-design` PD-AUD-1 fire-and-forget).
- **Access boundary**: this unit has `events` subscribe permission on the
  workflow `detail-type`s only; it has **no** permission on the workflow's
  request table, and the workflow has **no** permission on the audit store. The
  bus is the anti-corruption membrane, translated on ingest by the C3 ACL mapper.

## Shared session/auth and authz dependencies (consumed, not owned)

- **Session validation** (`unit-platform-auth`) and the **authz decision**
  (`unit-platform-authz`) are in-process library calls on the read surface, not
  network services, so this unit adds no infrastructure for them
  (`security-design` SD-AUD-1). Both are **Critical to reads** and fail **closed**
  — no session → `401`, cannot authorize → `err(forbidden)` returning zero
  records (`reliability-design` degradation table; `security-design` SD-AUD-2).
  The auth session store and the authz directory table are owned and sized by
  those units; this unit only relies on their availability, and only for its read
  surface (ingest is unaffected — `logical-components` FD-4).

## Blast-radius & failure-domain boundaries

Drawn from `logical-components` FD-1…FD-5 and `reliability-design`:

- **Ingest-consumer instance loss (FD-1)** affects only unprocessed events on the
  bus/queue, redelivered elsewhere (stateless + idempotent, `reliability-design`
  RD-AUD-4); it cannot corrupt already-appended records (append-only). Blast
  radius: **in-flight events**, no data loss.
- **Audit store outage (FD-2)** delays recording and degrades reads but **does
  not** affect the workflow command path — ingest retries/re-queues and the
  workflow keeps committing (`reliability-design` RD-AUD-3). Blast radius:
  **delayed recording + degraded reads**, bounded by the completeness SLO.
- **Bus/subscription outage (FD-3)** delays ingest; committed transitions are
  buffered upstream and recorded on recovery. Blast radius: **compliance-
  visibility latency**, never workflow availability or transition loss.
- **Auth/authz outage (FD-4)** fails the read surface closed but leaves ingest
  and the durable evidence untouched. Blast radius: **auditor read availability
  only**.
- **Silent corruption/tampering (FD-5)** is detected by the C7 scheduled
  `verifyChain` sweep as an integrity incident (`security-design` SD-AUD-6/8),
  bounded to the affected partition(s) and provably so.

## Cost-allocation ownership

All shared and owned resources carry the mandatory cost-allocation tags
(`Project`, `Environment`, `Team`, `Service=audit-trail`, `CostCenter`) so this
unit's DynamoDB, S3 Object Lock, SQS, and scheduled-job cost is attributable
within the shared monolith bill (cost-optimization knowledge; enforced by the CDK
tagging aspect in `deployment-architecture`). Shared compute/network/pipeline cost
is attributed at the monolith level; the **audit store (DynamoDB + GSI), the WORM
bucket, the ingest queue + DLQ, the integrity-sweep schedule, and the
retention/tiering lifecycle** are the line items uniquely owned here
(`logical-components` shared-resource identification).
