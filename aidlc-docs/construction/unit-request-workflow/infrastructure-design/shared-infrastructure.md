# Shared Infrastructure — `unit-request-workflow`

This unit is one **embedded in-process module** of a modular monolith
([[logical-components]] ADR-WF-COMP-01 "embedded module boundary, not a separate
service"; [[components]] modular-monolith architecture; [[services]] five
logical services in one deployable). It therefore **shares** most of its
infrastructure with the already-shipped units (`unit-platform-auth`,
`unit-platform-authz`, `unit-hris-balance`) and its future sibling consumers
(`audit-trail`, `notification`, `overlap-indicator`, `status-tracking`). This
document draws the **ownership and access boundaries** so that shared resources
have a single owner and this unit's blast radius stays contained
([[logical-components]] failure-domains & blast-radius;
[[reliability-design]] blast-radius note).

## Shared vs Owned — inventory

| Resource | Owner | This unit's relationship | Source |
|----------|-------|--------------------------|--------|
| ECS Fargate cluster + task/service + ALB + VPC | Platform (monolith) | **Shares** — runs as in-process code in the same task | [[deployment-architecture]]; [[components]] |
| VPC, subnets, security groups, NAT, VPC endpoint | Platform (`NetworkStack`) | **Shares** | [[deployment-architecture]] |
| Session / revocation store | `unit-platform-auth` | **Consumes** (in-process session validation) read-only | [[services]]; [[reliability-design]] degradation table (Critical) |
| Role/Department directory table (DynamoDB) | `unit-platform-authz` | **Consumes** via `AuthzService.decide` in-process; never reads the table directly | authz code-summary; [[business-logic-model]] Data Flow |
| **`vacation-requests-<env>` table (DynamoDB)** | **`unit-request-workflow` (this unit)** | **Owns** | [[domain-entities]]; [[infrastructure-services]] |
| EventBridge choreography bus | Platform (shared bus) | **Publishes** its 5 domain events; does not own the bus | [[scalability-design]] ADR-WF-SCALE-01; [[services]] |
| Streams→EventBridge outbox forwarder | **This unit** (its table's stream) | **Owns** the forwarder for its own table's stream | [[infrastructure-services]] |
| Immutable audit store + 7-year archive | `audit-trail` unit | **Feeds** it via events; does not own retention | [[reliability-design]] REL-WF-9; `req-nfr-audit-retention` |
| CloudWatch/X-Ray observability plane | Platform | **Shares**; adds its own metrics/alarms | [[monitoring-design]] |
| CI/CD pipeline (CodePipeline/CodeBuild) | Platform | **Shares** the single monolith pipeline | [[cicd-pipeline]] |
| Secrets / SSM parameters | Platform + per-unit namespaces | **Owns** its `request-workflow/*` params | [[infrastructure-services]]; [[security-design]] SEC-WF-9 |

## Ownership rule: the request store is this unit's, and only this unit's

The `vacation-requests-<env>` DynamoDB table is **written exclusively by the
workflow command path** ([[business-logic-model]] Workflows A/B/C;
[[domain-entities]] `VacationRequestRepository`). No other unit writes it:

- `status-tracking` **reads** the persisted request state/history projection
  ([[business-logic-model]] Data Flow) — it may attach a GSI or maintain its own
  read model, but it does not mutate the aggregate. Its read access is a
  least-privilege `Query`/`GetItem` grant, never write ([[security-design]]
  SEC-WF-10 append-only integrity).
- `audit-trail`, `notification`, `overlap-indicator` receive **events**, never
  table access ([[services]] choreography; [[domain-entities]] "cross-unit
  references by id, not object graph").

This single-writer ownership is the structural guarantee behind the append-only
invariant ([[business-rules]] `BR-INV-4`) and the no-override rule
([[security-design]] SEC-WF-4): if only the workflow service can write, and its
IAM policy forbids `UpdateItem`/`DeleteItem` on `TX#` items, then history is
tamper-evident at the infrastructure layer, not merely by convention.

## Cross-unit event contract (the shared bus)

The shared EventBridge bus is the **only** coupling point between this unit and
its downstream consumers ([[scalability-design]] ADR-WF-SCALE-01;
[[reliability-design]] REL-WF-2 dependency isolation):

- **This unit publishes** `RequestSubmitted`, `RequestValidated`,
  `RequestApproved`, `RequestRejected`, `RequestWithdrawn` — PII-free, keyed by
  `requestId`/`ownerId` ref/`department` ([[security-design]] SEC-WF-6;
  [[domain-entities]] Domain Events).
- **Consumers subscribe** with their own EventBridge rules and own their own
  DLQs and retry policy. A slow or failed consumer never back-pressures the
  command path ([[performance-design]] "event emission is fire-and-forward";
  [[reliability-design]] "Important" tier — async, command commits regardless).
- **Access boundary**: this unit has `events:PutEvents` on the bus for its
  `detail-type`s only; it has **no** permission on consumer resources, and
  consumers have **no** permission on the request table. The bus is the
  anti-corruption membrane.

## Shared session/auth and directory dependencies (consumed, not owned)

- **Session validation** (`unit-platform-auth`) and the **authz decision**
  (`unit-platform-authz`) are in-process library calls, not network services, so
  this unit adds no infrastructure for them ([[business-logic-model]] Data Flow;
  [[infrastructure-services]] external integrations). Both are **Critical**
  dependencies that fail **closed** — no session → 401, cannot authorize → deny
  ([[reliability-design]] REL-WF-3; [[security-design]] SEC-WF-2). The auth
  session store and the authz directory table are owned and sized by those units;
  this unit only relies on their availability.

## Blast-radius & failure-domain boundaries

- A failure of this unit's **request table** degrades only the workflow command
  path (submit/validate/approve/reject) — it returns retryable errors with no
  partial writes ([[reliability-design]] failure-mode checklist,
  [[business-rules]] `BR-INV-3/4`); it does not affect auth, authz, HRIS reads,
  or the shared compute for other units' routes.
- A failure of this unit's **outbox forwarder** delays audit/notification but
  leaves committed state intact and replayable ([[reliability-design]] REL-WF-6;
  [[monitoring-design]] DLQ alert).
- Because the unit is stateless code in a shared task ([[scalability-design]]),
  a task-instance failure affects only in-flight requests on that instance, which
  retry on another instance ([[reliability-design]] blast-radius note) — the
  shared compute's multi-AZ posture ([[deployment-architecture]]) contains it.

## Cost-allocation ownership

All shared and owned resources carry the mandatory cost-allocation tags
(`Project`, `Environment`, `Team`, `Service=request-workflow`, `CostCenter`) so
this unit's DynamoDB and outbox-Lambda cost is attributable within the shared
monolith bill (cost-optimization knowledge; enforced by the CDK tagging aspect in
[[deployment-architecture]]). Shared compute cost is attributed at the monolith
level; the request table and forwarder are the line items uniquely owned here.
