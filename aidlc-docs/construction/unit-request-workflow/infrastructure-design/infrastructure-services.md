# Infrastructure Services — `unit-request-workflow`

The backing AWS services for the **Vacation Request Workflow** unit: the durable
request database, the event transport that carries its domain events to
downstream consumers, caching posture, and external-service integration. These
choices realise the persistence contract in [[domain-entities]]
(`VacationRequestRepository`), the same-logical-commit event rule in
[[business-logic-model]] (Data Flow) and [[business-rules]] (`BR-INV-5`), the
broker-ready choreography posture in [[scalability-design]] (ADR-WF-SCALE-01),
and the degradation tiers in [[reliability-design]]. They inherit the
security/PII rules of [[security-design]] and the modular-monolith service
grouping of [[services]] and [[components]].

## Database — DynamoDB request store

**Amazon DynamoDB**, single table, keyed to the aggregate. This is the concrete
realisation of the append-only port that [[domain-entities]] and
`tech-stack-decisions` left open.

- **Table**: `vacation-requests-<env>`.
- **Key schema** (item-per-transition, append-only):
  - Partition key `PK = REQ#<RequestId>`.
  - Sort key `SK = REQ#META` (the aggregate head: `ownerId`, `department`,
    `dates`, `status`, `rejectedStage`, `version`) and `SK = TX#<zero-padded seq>`
    for each immutable `Transition` ([[domain-entities]] `Transition`;
    [[business-rules]] `BR-INV-4`). Transition items are **write-once** — the IAM
    policy and a CDK aspect forbid `UpdateItem`/`DeleteItem` on `TX#` items,
    making append-only structural, not conventional (`req-constraint-append-only-store`,
    [[security-design]] SEC-WF-10).
- **Optimistic concurrency** ([[business-rules]] `BR-INV-2/3`,
  [[reliability-design]] REL-WF-5): the META-item write uses
  `ConditionExpression: version = :expectedVersion`; a mismatch surfaces
  `ConditionalCheckFailedException`, which the adapter maps to the domain's
  `err(staleState)` — no lock, no lost update, matching [[performance-design]]
  "optimistic concurrency, not locking".
- **Capacity**: on-demand in dev/staging (zero idle cost for a bursty workload —
  cost-optimization knowledge), provisioned + autoscaling in production for the
  seasonal peaks ([[scalability-design]] load projections). TTL is **not** used —
  history is retained, not expired ([[scalability-design]] "never delete or
  mutate history").
- **Encryption at rest**: SSE with a KMS key (AWS-managed minimum; customer-
  managed if compliance dictates) — [[security-design]] SEC-WF-8,
  `req-nfr-security-pii`.
- **Point-in-time recovery (PITR)**: enabled, giving the recoverability
  [[reliability-design]] REL-WF-9 requires and feeding the 7-year retention the
  `audit-trail` unit owns (`req-nfr-audit-retention`).
- **Durability/backup**: PITR (35-day continuous) plus scheduled on-demand
  backups; the long-horizon 7-year archive is the `audit-trail` unit's
  responsibility, sourced from the stream below — see [[shared-infrastructure]].

## Messaging — DynamoDB Streams → EventBridge (choreography bus)

The unit emits exactly one domain event per accepted transition, in the **same
logical commit** as the state change ([[business-rules]] `BR-INV-5`,
[[reliability-design]] REL-WF-4). The infrastructure realises this with a
**transactional-outbox pattern** so the guarantee survives at the infra layer:

```
workflow service ──(conditional write: META + TX item)──► DynamoDB
                                                              │
                                                    DynamoDB Streams (NEW_IMAGE)
                                                              │
                                                     Lambda outbox forwarder
                                                              │
                                                   Amazon EventBridge (bus)
                                          ┌───────────────────┼───────────────────┐
                                    audit-trail          notification        overlap-indicator
```

- The state write and the event are never independently lost: the event is
  **derived from the committed write** via Streams, so there is no window where
  state is persisted but the event is missing (nor vice-versa) — this is the
  infra-level enforcement of BR-INV-5 / REL-WF-4.
- **Amazon EventBridge** is the broker-ready choreography bus
  ([[scalability-design]] ADR-WF-SCALE-01 "broker-ready in-process event bus for
  side-effects"). The **in-process event bus remains the dev/test default**
  behind the same seam; deployed environments wire EventBridge — consistent with
  the port/adapter swap pattern across the monolith.
- **Event routing** ([[domain-entities]] Domain Events): `RequestSubmitted`,
  `RequestValidated`, `RequestApproved`, `RequestRejected`, `RequestWithdrawn`
  are published with a `detail-type` per event; EventBridge rules fan them out to
  the `audit-trail`, `notification`, and `overlap-indicator` consumers per
  [[services]] choreography. Payloads carry only pseudonymous ids
  ([[security-design]] SEC-WF-6 — PII-free events).
- **Decoupling** ([[reliability-design]] REL-WF-2, degradation table): consumers
  are asynchronous; if a consumer is down the command still commits and the event
  is retried by EventBridge (DLQ on the forwarder Lambda for poison events).
  Downstream slowness never back-pressures the submission path
  ([[performance-design]] "event emission is fire-and-forward").

## Caching

- **No hot-path cache for the command path.** [[performance-design]] keeps each
  command to a single-key read + append write; the ≤ 50 ms `findById` budget is
  met by DynamoDB directly, so a cache would add invalidation risk against the
  strict optimistic-concurrency `version` for no latency win.
- **Authorization data is cached in-process by the authz unit already**
  ([[performance-design]] command-path authz ≤ 5 ms is an in-process Set check);
  this unit adds no authz cache.
- **Advisory reads are off the command path** ([[reliability-design]]
  degradation table; [[business-rules]] `BR-VAL-6`): the HRIS balance and overlap
  indicator are owned by their own units (`unit-hris-balance` uses its own
  short-TTL cache) and are never fetched inside the workflow command budget.

## External Service Integrations

- **`unit-platform-authz` (in-process)**: consumed as a library call
  `AuthzService.decide(...)` ([[business-logic-model]] Data Flow) — no network
  service, no infra dependency of its own beyond the shared `RoleDirectoryPort`
  DynamoDB table the authz unit owns (see [[shared-infrastructure]]).
- **`unit-platform-auth` (in-process)**: session validation is in-process; the
  shared session/revocation store is auth-owned ([[shared-infrastructure]]).
- **`unit-hris-balance` (advisory, out of band)**: read-only, off the command
  path, degrades non-blockingly ([[reliability-design]] REL-WF-2). No infra owned
  here.
- **Downstream consumers** (`audit-trail`, `notification`, `overlap-indicator`)
  integrate **only** via EventBridge events — no direct call, no shared table
  with this unit ([[services]] choreography; [[domain-entities]] "cross-unit
  references by id, not object graph").

## Service Discovery & Configuration

- In-process modules need no service discovery — they resolve each other by
  import within the monolith ([[logical-components]] embedded-module boundary).
- Table names, bus name, and KMS key ARNs are injected via **SSM Parameter
  Store** / environment at task start ([[security-design]] SEC-WF-9 "no secrets
  in code"); the CDK stack writes them and the task reads them, so nothing is
  hardcoded.
