# Shared Infrastructure — `unit-notifications`

This unit is one **embedded consumer of a modular monolith** (`logical-components`
producer seam C1 and in-app read seam C9 run in-process; `components`
modular-monolith architecture; `services` five logical services in one deployable).
Its **async delivery tier (C3–C8) is additive infrastructure** — a durable queue,
DLQ, two DynamoDB stores, and an email binding — but even those hang off shared
platform primitives (the EventBridge choreography bus, the VPC/compute, KMS,
identity). This document draws the **ownership and access boundaries** so shared
resources have a single owner and this unit's blast radius stays contained
(`logical-components` failure-domains & blast-radius; `reliability-design`
blast-radius note). It complements the `unit-request-workflow` shared-infrastructure
document, which established the platform baseline this unit consumes.

## Shared vs Owned — inventory

| Resource | Owner | This unit's relationship | Source |
|----------|-------|--------------------------|--------|
| ECS Fargate cluster + task/service + ALB + VPC | Platform (monolith) | **Shares** — producer C1 + in-app read C9 run as in-process code in the same task | `deployment-architecture`; `components` |
| VPC, subnets, security groups, NAT, VPC/Gateway endpoints | Platform (`NetworkStack`) | **Shares**; adds SQS/SES/KMS interface endpoints for the delivery tier | `deployment-architecture` |
| **EventBridge choreography bus** | Platform / `unit-request-workflow` (publisher) | **Subscribes only** — owns an EventBridge **rule** that targets its own SQS queue for 5 `detail-type`s; adds nothing to events; producer stays unaware | `services`; `logical-components` shared-resource table; `unit-request-workflow` shared-infrastructure |
| **`vacation-requests-<env>` table** | `unit-request-workflow` | **No access** — receives events, never table access | `services` choreography |
| **Notification SQS queue (C2) + DLQ (C8)** | **`unit-notifications` (this unit)** | **Owns** | `infrastructure-services`; `logical-components` C2/C8 |
| **`notifications-inapp-<env>` table (C6)** | **This unit** | **Owns** | `infrastructure-services`; `logical-components` C6 |
| **`notifications-delivery-<env>` table (C7)** | **This unit** | **Owns** | `infrastructure-services`; `logical-components` C7 |
| **SQS→Lambda delivery worker (C3)** | **This unit** | **Owns** | `deployment-architecture`; `logical-components` C3 |
| **SES email binding (C5)** | **This unit** (uses the platform SES account) | **Owns** the identity/config-set + sending; shares the account | `infrastructure-services` |
| `CryptoPort` / KMS key for PII fields (C10) | Platform (shared capability) | **Consumes** — field-level encrypt of in-app bodies; fail-closed | `security-design` BR-PII-3; `logical-components` C10 |
| Identity / `AuthenticatedPrincipal` | `unit-platform-auth` | **Consumes** read-only on the C9 in-app read path; no auth logic here | `security-design`; `logical-components` shared-resource table |
| Recipient directory backing store (C4) | IdP / HRIS / internal directory | **Reads** read-only via `RecipientDirectoryPort` + in-proc cache; concrete source is an open item | `logical-components` hand-off; `memory.md` |
| Send capability (`EmailSenderPort`/`InAppInboxPort`) | **This unit** | **Owns** — `unit-sla-escalation` (downstream) reuses it for timed reminders; this unit owns the send, not the scheduling | `logical-components` shared-resource table; `business-logic-model` |
| CloudWatch/X-Ray observability plane | Platform | **Shares**; adds its own metrics/alarms | `monitoring-design` |
| CI/CD pipeline (CodePipeline/CodeBuild) | Platform | **Shares** the single monolith pipeline | `cicd-pipeline` |
| Secrets / SSM parameters | Platform + per-unit namespaces | **Owns** its `notifications/*` params | `infrastructure-services`; `security-design` |

## Ownership rule: the queue and delivery stores are this unit's, and only this unit's

The SQS queue (C2), DLQ (C8), and the two DynamoDB tables (C6 in-app, C7 delivery)
are **written exclusively by this unit's worker** (`business-logic-model`
pipeline; `logical-components`). No other unit writes them:

- The **delivery-record store is append-only single-writer**: only the worker's
  role has `PutItem`/`GetItem`/`Query`, and its IAM policy + a CDK aspect forbid
  `UpdateItem`/`DeleteItem` — making the append-only invariant
  (`reliability-design` BR-NOTIF-11; `security-design` STRIDE-Tampering) structural,
  not conventional.
- The **in-app store** is written only by the worker and read only by the in-app
  read seam (C9), which is **self-scoped per principal** (`security-design`
  self-scope; the `RCPT#<recipientId>` partition physically bounds a query to one
  recipient). No cross-unit access.
- `unit-sla-escalation` (downstream) reuses the **send ports**, not the stores or
  queue; it will own its own scheduling infra.

## Cross-unit event contract (the shared bus)

The shared EventBridge bus is the **only** coupling point between this unit and its
producer (`unit-request-workflow`) (`services` choreography; `scalability-design`
choreography-consumer shape; `reliability-design` REL-NOTIF-2 decoupling):

- **This unit subscribes** to `RequestSubmitted`, `RequestValidated`,
  `RequestApproved`, `RequestRejected`, `RequestWithdrawn` via an EventBridge
  **rule** whose target is this unit's SQS queue. Events are **PII-free** by
  construction (`security-design` BR-PII-1), keyed by `requestId`/`ownerId`
  ref/`department`/`status`/`atMs`.
- **Access boundary**: this unit has **no** permission on the workflow's request
  table and the workflow has **no** permission on this unit's queue, DLQ, or stores.
  The bus is the anti-corruption membrane — the same discipline the workflow unit's
  shared-infrastructure document established for its downstream consumers.
- **Independent DLQ + retry**: this unit owns its own SQS redrive/DLQ and retry
  policy; a slow or failed notification consumer **never back-pressures the command
  path** (`performance-design` fire-and-forward enqueue; `reliability-design`
  Important tier — command commits regardless).

## Shared identity, crypto, and directory dependencies (consumed, not owned)

- **Identity** (`unit-platform-auth`): the in-app read seam (C9) receives an
  already-`AuthenticatedPrincipal`; this unit adds **no authentication surface** of
  its own (`security-design` authentication-inherited). The event-consumer path is
  unauthenticated by design — its trust boundary is the broker, not a user.
- **`CryptoPort` / KMS** (platform shared capability): consumed to field-encrypt
  persisted in-app PII bodies; **fail-closed** on unavailability (no plaintext PII
  written) — `security-design` BR-PII-3.
- **Recipient directory** (IdP/HRIS/internal): read-only via C4 with a short-TTL
  in-process cache that **sheds load** from the directory system of record
  (`scalability-design`, `performance-design`); the concrete source binding is an
  open item (`memory.md`).

## Blast-radius & failure-domain boundaries

Per `logical-components` failure domains and `reliability-design`, **no failure in
any of this unit's components reaches the workflow command path**:

- A **worker instance crash** affects only in-flight events on that worker; SQS
  redelivers (at-least-once) and idempotency makes resumption safe.
- An **SES (email) outage** trips only the email breaker → DLQ; **in-app delivery
  continues** (bulkhead, BR-NOTIF-7).
- An **in-app store outage** trips only the in-app breaker → DLQ; **email still
  sent**.
- A **queue/bus delay** grows SQS depth (the scale signal) but the producer is
  non-blocking, so the **workflow commits regardless** (`reliability-design`
  REL-NOTIF-2).
- **CryptoPort unavailable** → in-app persist fails closed → retry/DLQ; no plaintext
  PII, no workflow impact.

The choreography boundary caps this unit's blast radius at **notification delivery
latency/completeness** — never at workflow correctness (`logical-components`
blast-radius mapping).

## Cost-allocation ownership

All owned resources carry the mandatory cost-allocation tags (`Project`,
`Environment`, `Team`, `Service=notifications`, `CostCenter`) so this unit's SQS,
Lambda, DynamoDB, and SES cost is attributable within the shared monolith bill
(cost-optimisation knowledge; enforced by the CDK tagging aspect in
`deployment-architecture`). Shared compute cost (the producer C1 / read C9 seams
inside the monolith task) is attributed at the monolith level; the queue, DLQ, two
tables, worker Lambda, and SES sending are the line items uniquely owned here.
