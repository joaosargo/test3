# Scalability Requirements — `unit-status-query`

Scalability NFRs for the **Status Tracking & Query** unit — the read side of the
vacation-request modular monolith. Scale is driven by the size of the employee
population and how often each role checks status (an employee glancing at their
own list; a team lead scanning a queue; an HR approver reviewing a department
view), described in [[business-logic-model]] (Query Flows), bounded by the
pure-read and derived-status invariants in [[business-rules]] (`BR-SQ-8`,
`BR-SQ-15`, `BR-SQ-17`), and by the concurrency and audit-retention NFRs in
[[requirements]] (`req-nfr-concurrency`, `req-nfr-audit-retention`,
`req-status-tracking`).

This is an internal line-of-business read surface: growth is a function of
headcount and seasonal peaks (start-of-quarter, holiday windows), not viral or
machine traffic. The scaling strategy favours **stateless horizontal reads over
the shared append-only store**, avoiding a separate eventually-consistent read
store until read volume actually diverges from write volume — a design-for-change
seam, not premature distributed complexity.

## Load Projections

| Dimension | Baseline assumption (confirm at nfr-design) | Growth horizon |
|-----------|---------------------------------------------|----------------|
| Employees (potential readers) | up to a few thousand | 2×–3× over 3 years |
| Status reads / day | low thousands at peak (reads outnumber writes) | scales with headcount |
| Reads / request lifetime | several (each role checks status repeatedly) | grows with engagement, not per-request state |
| Concurrent in-flight reads | ≤ 100 peak (placeholder) | per `req-nfr-concurrency` |
| Aggregate read throughput | ≤ 50 read-req/s peak (placeholder) | 2× headroom |
| Timeline size per request | ≤ 3 accepted transitions (bounded) | fixed by the state machine |

Read volume is higher than the command-path write volume ([[scalability-requirements]]
of `unit-request-workflow` sizes the write side), because status is checked far
more often than it changes. Crucially, per-request **projection cost is bounded**:
a timeline is at most three transitions ([[business-logic-model]] Read Model;
[[business-rules]] `BR-SQ-11`), so read cost grows with the number of reads and
the number of requests, never with per-request complexity.

## Scaling Strategy

- **Stateless horizontal scaling.** `StatusQueryService` keeps no per-request or
  session state between calls; every query reads through the
  `VacationRequestRepository` port ([[business-logic-model]] Data Flow). Instances
  scale out behind a load balancer with no session affinity — the same posture
  the shipped `unit-platform-auth` / `unit-platform-authz` /
  `unit-request-workflow` services use.
- **Authorization scales in-process.** The authz check is an O(1) in-process
  grant-table lookup (authz `code-summary`), so adding read instances adds no
  authorization-service network load.
- **Reads are pure — trivially parallelisable.** Because no query writes or emits
  events ([[business-rules]] `BR-SQ-15`), reads take no locks and never contend
  with each other or back-pressure the command path; read replicas or additional
  instances add capacity linearly.
- **Read/write split without full CQRS machinery.** This unit is the query half
  of a CQRS-leaning split: it reads the same append-only store the command side
  writes, via the shared port, as a **synchronous on-demand projection** rather
  than a separate eventually-consistent copy ([[business-logic-model]] Design
  Approach). This avoids replication-lag and rebuild cost at the current scale
  while letting the read side scale its instance count independently of the write
  side.
- **Materialized projection is a deferred, port-isolated option.** If read volume
  diverges sharply from write volume, the `VacationRequestRepository` seam allows
  swapping in a materialized read projection (or a `findByDepartmentAndStatus`
  index optimized for the queue query) or a short-TTL read cache **without
  changing this unit's public query surface** ([[business-logic-model]] Design
  Approach; see [[performance-requirements]] NFR-SQ-PERF-8). Not built now —
  design-for-change over premature optimization.

## Data Growth & Retention

- **NFR-SQ-SCALE-1 — This unit stores nothing; growth is inherited.** The unit
  owns no state ([[business-rules]] `BR-SQ-8`, `BR-SQ-15`); the data it reads
  grows linearly in request count on the `unit-request-workflow` append-only
  store, which owns store sizing. This unit's read cost tracks that same linear
  growth, offset by scope filtering (each read touches only one owner, team, or
  department, not the whole population).
- **NFR-SQ-SCALE-2 — Query cost is scope-bounded, not population-bounded.** A
  read never scans the entire request set ([[business-rules]] `BR-SQ-5`); it uses
  `findByOwner` / `findByDepartmentAndStatus`, so as headcount grows the cost of
  an individual read stays bounded by the caller's scope, and total read cost
  grows with concurrency rather than with dataset size.
- **NFR-SQ-SCALE-3 — Seven-year retention is upstream.** The 7-year retention of
  the underlying history (`req-nfr-audit-retention`) is owned by the
  `audit-trail` unit and the durable store; this unit only reads whatever the
  store retains. Long-term archival/tiering of aged records may make cold-request
  timelines slower to read — an infrastructure-design concern to confirm, not a
  correctness issue for this unit.

## Scaling Triggers & Limits

- **NFR-SQ-SCALE-4 — Scale-out trigger.** Add status-query instances when
  sustained CPU or per-instance in-flight read count approaches the sizing
  threshold; concrete autoscaling thresholds are set in nfr-design against the
  confirmed `req-nfr-concurrency` read figure.
- **NFR-SQ-SCALE-5 — Store read limit is the primary bound.** The shared store's
  read IOPS and the efficiency of the `findByDepartmentAndStatus` scan are the
  main scaling limits for the queue query; an index on `(department, status)` or
  a materialized queue projection (NFR-SQ-SCALE, deferred) addresses this if the
  queue read becomes hot.
- **NFR-SQ-SCALE-6 — No premature sharding or read store.** At the projected
  volume the synchronous on-demand projection over a single logical store
  suffices; a dedicated read store or `RequestId`-based sharding is available if
  growth demands it but is not required for MVP.

## Open Items (for nfr-design)

- Replace placeholder read-concurrency/throughput/headcount figures with the
  quantified target from [[requirements]] `req-nfr-concurrency`, split for the
  read surface.
- Decide with infrastructure-design whether the queue query needs a
  `(department, status)` index or a materialized projection, or whether the
  on-demand projection over the shared store remains sufficient.
- Confirm the read-latency impact of long-term retention/archival of aged
  request timelines jointly with the `audit-trail` unit and infrastructure-design.
