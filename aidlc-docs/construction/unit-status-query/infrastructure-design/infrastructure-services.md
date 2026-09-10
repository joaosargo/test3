# Infrastructure Services — `unit-status-query`

The backing AWS services for the **Status Tracking & Query** unit: the store it
reads, the (deliberately absent) cache, the (absent) messaging, and the external
integrations it consumes. These choices realise the read-only persistence-access
contract in `business-logic-model` (Data Flow) and `tech-stack-decisions`
(reuse `VacationRequestRepository`), the no-cache-at-MVP decision in
`performance-design` (PERF-D-4), the scoped-read index strategy in
`scalability-design` (SCALE-D-7), and the fail-closed dependency tiers in
`reliability-design`. They inherit the least-privilege read grant and PII rules of
`security-design` and the modular-monolith service grouping of `services` and
`components`.

The organising principle from `logical-components`: this unit **owns no backing
service**. Every "infrastructure service" below is either **consumed read-only**
(the request store) or **inherited in-process** (auth/authz) — there is no
database, cache, queue, or bus in this unit's ownership boundary.

## Database — consumed read-only, not owned

The unit reads the **workflow-owned** `vacation-requests-<env>` DynamoDB table
through the shared `VacationRequestRepository` port; it provisions no table of its
own (`tech-stack-decisions` "no new persistence, no new port";
`business-logic-model` Data Flow).

- **Access pattern (read-only).** Three bounded reads map to three DynamoDB
  operations, each scope-bounded and never a full scan (`scalability-design`
  SCALE-D-6; `business-logic-model` Query Flows):
  - `findById` → `GetItem` on `PK = REQ#<RequestId>` (aggregate head + history),
    budgeted ≤ 50 ms p95 (`performance-design` aggregate-load budget).
  - `findByOwner` → `Query` on an owner access path, bounded per-employee set.
  - `findByDepartmentAndStatus` → `Query` on the `(department, status)` secondary
    index (below), budgeted ≤ 200 ms p95 (`performance-design` Query B).
- **`(department, status)` GSI.** `scalability-design` SCALE-D-7 specifies a GSI
  with partition key `department` and sort key `status` so the scoped-queue read
  is a bounded `Query`, never a scan. It is defined **on the workflow-owned
  table** — this unit cannot create indexes on a table it does not own — and this
  unit's grant on the index is read-only `Query`. **Build-vs-defer** is the one
  open provisioning decision: at MVP read volume (≤ 50 read-req/s placeholder,
  `scalability-design` load projections) a bounded `Query` on the base table's
  owner/department access path may suffice, but the queue read
  (`listScopedRequests`) is the access pattern most likely to grow with department
  size. Recommendation: **build the GSI at MVP** for the queue read because it is
  cheap on a DynamoDB table and removes the only scan risk on the read surface;
  confirm against the concrete `req-nfr-concurrency` figure per the
  `scalability-design` open items.
- **Least-privilege grant (read-only).** The Fargate task role grants only
  `dynamodb:GetItem` and `dynamodb:Query` on the table and the GSI — **never**
  `PutItem`/`UpdateItem`/`DeleteItem`/`dynamodb:*` (`security-design` SEC-D-5;
  `logical-components` LC-11). This read-only grant is the infrastructure-level
  enforcement of the single-writer append-only invariant across the read/command
  split.
- **At-rest encryption & durability inherited.** SSE/KMS at rest, PITR, and the
  7-year retention feed are owned by `unit-request-workflow` and `audit-trail`
  (`security-design` SEC-D-10; `reliability-design` REL-D-18). After any store
  restore, this unit's projections are immediately correct because they are
  derived on demand from the restored history (`reliability-design` REL-D-11) —
  there is no read model to rebuild.
- **Consistency.** Reads are a synchronous on-demand projection over the same
  strongly-consistent append-only store the command side writes
  (`scalability-design` SCALE-D-5; `reliability-design` REL-D-11), so a projection
  reflects every transition committed at read time — the reason a fallback cache
  is rejected (below).

## Caching — deferred, port-isolated, none at MVP

- **No cache at MVP.** `performance-design` PERF-D-4 keeps the synchronous
  on-demand projection over the shared store as the read path; at the projected
  volume it is fast enough and a cache would add invalidation risk against the
  strongly-consistent store for no latency win. This unit provisions **no
  ElastiCache/Redis-class resource**.
- **If added later: cache-aside behind the port, strict TTL + event-driven
  invalidation.** `performance-design` PERF-D-5 records the only correctness-safe
  shape — a short-TTL (30–60 s timeline; 10–30 s queue) cache-aside, invalidated by
  the workflow unit's `Request*` transition events on the shared bus, keyed to
  include the authorization scope so a hit can never widen access (`security-design`
  SEC-D-4; `business-logic-model` scope semantics). A cached view MUST NOT outlive
  a committed transition it does not reflect. Never cache a deny/error outcome
  (`reliability-design` REL-D-10 fail-closed).
- **Materialized read projection is the higher-volume alternative.** If read volume
  diverges sharply from write volume, `scalability-design` SCALE-D-12 /
  `performance-design` PERF-D-6 swap in a materialized `(department, status)`
  read projection behind the same port — provisioned then, not now, and chosen only
  against measured divergence.

## Messaging — none owned; potential future consumer only

- **This unit publishes and consumes no events at MVP.** Reads are pure and emit no
  domain events (`business-logic-model` Data Flow; `security-design` SEC-D-16); a
  status view is not an audited fact. There is no EventBridge rule, queue, or DLQ in
  this unit's ownership.
- **The one future messaging touchpoint** is the deferred cache-invalidation
  subscription: if the PERF-D-5 cache is ever built, this unit would add an
  EventBridge rule subscribing to the workflow unit's PII-free `Request*` events
  (`shared-infrastructure` cross-unit event contract) purely to purge cache keys.
  Until then it wires nothing onto the shared bus.

## External Service Integrations

All cross-unit interaction is **in-process, read-only**, per `business-logic-model`
Data Flow and `tech-stack-decisions` integration contracts — no network service and
no infrastructure of its own:

- **`unit-platform-authz` (in-process).** Consumed as the library call
  `AuthzService.decide(principal, view-perm, { department? })`, treated as the
  authoritative permit/deny + `departmentScope` grant (`security-design` SEC-D-1/4).
  It is an O(1) grant-table check that adds **zero** authorization-service network
  load (`scalability-design` SCALE-D-2) — there is no PDP microservice to saturate.
- **`unit-platform-auth` (in-process).** Session validation via `requireSession`;
  the session/revocation store is auth-owned (`shared-infrastructure`). No/invalid
  session → 401 (`reliability-design` REL-D-6). This unit adds no infra for it.
- **`unit-request-workflow` (read source, via port).** The `VacationRequest`
  aggregate and its append-only `history` are read through the
  `VacationRequestRepository` port only — never write, never invoke a transition,
  never reach past the port into workflow internals (`tech-stack-decisions`
  integration; `business-logic-model` Data Flow). The store read is this unit's
  **only** external (network) dependency (`reliability-design` REL-D-15).
- **Outbound** — none. No downstream unit depends on this read unit
  (`tech-stack-decisions` Outbound: none).

## Service Discovery & Configuration

- **No service discovery.** In-process modules resolve each other by import within
  the monolith (`logical-components` embedded-module boundary); there is no endpoint
  to discover.
- **Configuration is minimal and injected.** This unit needs **no secret of its own**
  — it holds no store credential and reads through the shared port
  (`security-design` SEC-D-10; `tech-stack-decisions` Secrets). The one value it
  reads is the shared request-table/GSI name, injected via **SSM Parameter Store** /
  environment at task start alongside the monolith's existing parameters
  (`unit-request-workflow` `infrastructure-services` service discovery) — nothing
  hardcoded.
- **Read timeout & retry as configuration.** The store-read timeout (~800 ms,
  `reliability-design` REL-D-3) and bounded retry (≤ 2, jittered, transient-only —
  REL-D-4) are adapter-level configuration on the shared port binding, confirmed
  against the production store's measured latency distribution per the
  `reliability-design` open items.
