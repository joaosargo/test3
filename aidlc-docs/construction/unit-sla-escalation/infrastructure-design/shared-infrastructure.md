# Shared Infrastructure — `unit-sla-escalation`

This unit is one **embedded module of the modular monolith** (`logical-components`
scan seam C2 runs in-process; `components` modular-monolith architecture;
`services` five logical services in one deployable). It therefore **shares** most
of its infrastructure with the already-shipped units (`unit-platform-auth`,
`unit-platform-authz`, `unit-hris-balance`, `unit-request-workflow`,
`unit-notifications`) and **consumes upstream seams read-only-plus-send**. What it
**owns** is deliberately small: a **scheduler binding** and a **durable reminder
ledger**. This document draws the ownership and access boundaries so shared
resources have a single owner and this unit's blast radius stays contained
(`logical-components` failure-domains & blast-radius; `reliability-design`
blast-radius note). It complements the `unit-request-workflow` and
`unit-notifications` shared-infrastructure documents, which established the
platform baseline and the send seam this unit builds on.

## Shared vs Owned — inventory

| Resource | Owner | This unit's relationship | Source |
|----------|-------|--------------------------|--------|
| ECS Fargate cluster + task/service + ALB + VPC | Platform (monolith) | **Shares** — scan C2/C3 and debug read C9 run as in-process code in the same task | `deployment-architecture`; `components` |
| VPC, subnets, security groups, NAT, VPC/Gateway endpoints | Platform (`NetworkStack`) | **Shares**; adds a DynamoDB gateway-endpoint route + KMS/SSM interface use for the ledger | `deployment-architecture` |
| **EventBridge Scheduler schedule (C1) + its invoke role** | **`unit-sla-escalation` (this unit)** | **Owns** — fires `runScanTick` on cadence | `deployment-architecture`; `infrastructure-services`; `logical-components` C1 |
| **`sla-reminder-ledger-<env>` table (C6)** | **This unit** | **Owns** — append-only, single-writer | `infrastructure-services`; `logical-components` C6 |
| **Scan compute (C2/C3)** | **This unit** (in-process module; scheduled Lambda on the scale path) | **Owns the module**; shares the task | `deployment-architecture`; `logical-components` C2/C3 |
| **`vacation-requests-<env>` table** | `unit-request-workflow` | **Reads (read-only, narrowed view)** via `WorkflowPendingQueryPort` — never the mutating aggregate | `services`; `business-logic-model`; `security-design` SEC-DES-2 |
| EventBridge choreography bus | Platform / `unit-request-workflow` (publisher) | **Neither owns nor subscribes** — this unit is *not* event-driven; it fires on elapsed time | `business-logic-model` Inbound; `services` |
| Notification SQS queue / DLQ / SES / in-app store | `unit-notifications` | **No direct access** — reuses only the **send ports** (C8), never the queue/stores | `unit-notifications` shared-infrastructure; `logical-components` C8 |
| Recipient directory (C7) | `unit-notifications` / IdP / HRIS | **Reads read-only** via the reused `RecipientDirectoryPort` | `security-design` SEC-DES-3; `logical-components` C7 |
| Send capability `EmailSenderPort`/`InAppInboxPort` (C8) | `unit-notifications` | **Consumes** — builds SLA-flavoured messages, hands them to the same transport; inherits retry/DLQ/breaker | `business-logic-model`; `logical-components` C8; `BR-SLA-12` |
| Identity / `AuthenticatedPrincipal` (C9) | `unit-platform-auth` | **Consumes** read-only on the optional debug read; no auth logic here | `security-design` SEC-DES-4; `logical-components` C9 |
| Auth guard `requireSession → requirePermission` (C9) | `unit-platform-auth` / `unit-platform-authz` | **Consumes** — composes the debug read on the existing seam | `security-design` SEC-DES-4 |
| KMS key (ledger at-rest encryption) | Platform (shared capability) | **Consumes** — SSE for the ledger table | `security-design` SEC-DES-7 |
| Escalation policy / cadence config | This unit (config) | **Owns** its `sla-escalation/*` SSM params | `infrastructure-services`; `security-design` SEC-DES-3/10 |
| CloudWatch / X-Ray observability plane | Platform | **Shares**; adds its own metrics/alarms/dashboard (esp. missed-cadence) | `monitoring-design` |
| CI/CD pipeline (CodePipeline/CodeBuild) | Platform | **Shares** the single monolith pipeline | `cicd-pipeline` |
| Secrets / SSM parameters | Platform + per-unit namespaces | **Owns** its `sla-escalation/*` namespace | `infrastructure-services`; `security-design` SEC-DES-8 |

## Ownership rule: the reminder ledger is this unit's, and only this unit's

The `sla-reminder-ledger-<env>` DynamoDB table (C6) is **written exclusively by
this unit's scan compute** (`business-logic-model` pipeline; `logical-components`
C6). No other unit reads or writes it:

- The ledger is **append-only single-writer**: only the scan role has
  `PutItem`/`GetItem`/`Query`, and its IAM policy + a CDK aspect forbid
  `UpdateItem`/`DeleteItem` — making the append-only invariant (`security-design`
  SEC-DES-9; `reliability-design` REL-DES-10) **structural, not conventional**.
- The composite `(requestId, stage, tier)` key simultaneously enforces at-most-once
  dispatch and yields a tamper-evident operational decision trail
  (`security-design` SEC-DES-9). It is **distinct from** the compliance
  `audit-trail` (owned by `unit-audit-trail`, 7-year retention) and from the
  notification unit's `NotificationDelivery` record — it captures *SLA decisions*,
  not raw sends (`business-logic-model` Own durable state).
- Its retention is an **operational** TTL horizon, explicitly not the 7-year audit
  window (`reliability-design` REL-DES-12; `scalability-design` Data Growth).

## Read-only boundary over the workflow (consumed, not owned)

- This unit **reads** the workflow's pending requests through a **narrowed,
  read-only** `WorkflowPendingQueryPort` (`listPending` / `findById`) returning the
  PII-free `PendingRequestView`; it has **no permission** on the
  `vacation-requests-<env>` table's writes and **never** holds the mutating
  `VacationRequest` aggregate (`security-design` SEC-DES-2; `business-logic-model`
  Pending-request read). Architecturally enforced by *what is injected* — only the
  query port is wired into the scanner, so no code path can approve/reject/advance a
  request. This forecloses any privilege-escalation path through the scanner
  (`security-design` threat model).
- The read is **in-process** (same monolith deployable, `components`), one batch
  read per cadence, non-contending with the workflow command budget
  (`performance-design`; `scalability-design`). It is offloadable to a read
  replica / status projection if isolation is ever needed — with no scan-logic
  change.

## Not event-driven — the key contrast with `unit-notifications`

Unlike `unit-notifications`, this unit does **not** subscribe to the EventBridge
choreography bus and owns **no queue or DLQ**. It fires on the **absence** of a
transition — elapsed pending time — which no broker message can signal
(`business-logic-model` Inbound; `tech-stack-decisions` rejected a broker-driven
design). Its only inbound trigger is the **EventBridge Scheduler** schedule it
owns (C1). Dispatch of a due notice reuses the notification unit's send seam (C8),
which owns the transport reliability — so this unit adds no messaging
infrastructure and does not back-pressure the command path.

## Shared identity, crypto, and directory dependencies (consumed, not owned)

- **Identity** (`unit-platform-auth`): the optional debug read (C9) receives an
  already-`AuthenticatedPrincipal` and composes on `requireSession →
  requirePermission`; the scan path itself is a **trusted background actor with no
  user login** (`security-design` SEC-DES-1/4). This unit adds no authentication
  surface.
- **KMS** (platform shared capability): consumed for the ledger's at-rest SSE; the
  ledger is PII-free by construction, so at-rest exposure is minimal but still
  protected consistent with the shipped chain (`security-design` SEC-DES-6/7).
- **Recipient directory** (`unit-notifications` / IdP / HRIS): read-only via the
  reused `RecipientDirectoryPort` (C7); this unit does not derive who may receive a
  notice — it reuses the shared resolution (`security-design` SEC-DES-3). The
  escalation target is an injected, reviewed `escalationContactResolver` config.

## Blast-radius & failure-domain boundaries

Per `logical-components` failure domains and `reliability-design`, **no failure in
any of this unit's components reaches the workflow command path or corrupts
request/audit state**:

- A **scheduler miss / scanner crash** delays nudges by at most one cadence;
  catch-up fires each un-fired tier once on recovery (`reliability-design`
  REL-DES-8) — no lost or duplicated nudge, no workflow impact.
- A **ledger outage** halts *this unit's dispatch only* — the deliberate fail-safe
  bias toward not-spamming (`reliability-design` REL-DES-11); the workflow, audit,
  and other units are untouched.
- A **workflow read outage** yields a `WORKFLOW_READ_ERROR` value; the tick
  dispatches nothing and retries next cadence — workflow availability is
  independent (`reliability-design` REL-DES-3).
- A **directory / channel failure** degrades one recipient/tier to a recorded
  outcome (`RECIPIENT_UNRESOLVED` / `CHANNEL_DEAD_LETTERED`); the batch continues,
  and channel retries/DLQ are owned by `unit-notifications`, not here
  (`reliability-design` degradation tiers).

The choreography boundary caps this unit's blast radius at **reminder timeliness /
completeness** — never at workflow correctness (`logical-components` blast-radius
mapping; `security-design` SEC-DES-5 no state effect).

## Cost-allocation ownership

All owned resources carry the mandatory cost-allocation tags (`Project`,
`Environment`, `Team`, `Service=sla-escalation`, `CostCenter`) so this unit's
DynamoDB ledger and EventBridge Scheduler cost is attributable within the shared
monolith bill (cost-optimisation knowledge; enforced by the CDK tagging aspect in
`deployment-architecture`). Shared compute cost (the in-process scan C2/C3 and
debug read C9 inside the monolith task) is attributed at the monolith level; the
**reminder ledger table** and the **scheduler schedule** (plus a scan Lambda if
the scale path is activated) are the line items uniquely owned here — a very small
footprint (`infrastructure-services` Cost Notes).
