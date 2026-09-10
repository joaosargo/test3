# Scalability Requirements — `unit-request-workflow`

Scalability NFRs for the **Vacation Request Workflow** unit. Scale is driven by
the size of the employee population and the two-stage human approval cadence
described in [[business-logic-model]] (Workflows A/B/C), bounded by the
optimistic-concurrency and append-only invariants in [[business-rules]]
(`BR-INV-2/3/4`), and by the concurrency and audit-retention NFRs in
[[requirements]] (`req-nfr-concurrency`, `req-nfr-audit-retention`).

This is an internal line-of-business workflow: growth is a function of headcount
and seasonal peaks (start-of-quarter, holiday windows), not viral or
machine-generated traffic. The scaling strategy favours horizontal statelessness
plus a durable append-only store behind a port, avoiding premature distributed
complexity.

## Load Projections

| Dimension | Baseline assumption (confirm at nfr-design) | Growth horizon |
|-----------|---------------------------------------------|----------------|
| Employees (potential submitters) | up to a few thousand | 2×–3× over 3 years |
| New requests / day | low hundreds at peak (seasonal) | scales with headcount |
| Commands / request | ≤ 3 accepted transitions (submit → validate → approve/reject) | fixed by state machine |
| Concurrent in-flight commands | ≤ 50 peak (placeholder) | per `req-nfr-concurrency` |
| Aggregate throughput | ≤ 25 req/s peak (placeholder) | 2× headroom |

The command count per request is **bounded by the state machine**
([[business-logic-model]] Domain State Machine; [[business-rules]] transition
table): a request reaches a terminal state in at most three accepted
transitions, so per-request write volume does not grow with usage — only the
number of requests does.

## Scaling Strategy

- **Stateless horizontal scaling.** The workflow service keeps no session or
  per-request state between calls; all state lives in the `VacationRequest`
  aggregate behind the `VacationRequestRepository` port ([[domain-entities]]).
  Service instances therefore scale out behind a load balancer with no session
  affinity — the same posture the shipped `unit-platform-auth` /
  `unit-platform-authz` services use.
- **Authorization scales in-process.** The authz check is an O(1) in-process
  grant-table lookup (authz `code-summary`), so adding workflow instances does
  not add authorization-service network load.
- **Durable store behind the port.** The in-memory adapter is dev/test only;
  production wires a durable append-only store (e.g. a key-per-aggregate
  document/table). Because reads are single-key by `RequestId` and writes are
  append-only, the store shards cleanly on `RequestId` with no cross-shard
  transaction (transactions never span aggregates — [[business-logic-model]]).
- **Reads offloaded downstream.** Rich, role-scoped status queries are owned by
  `status-tracking` (`req-status-tracking`), not this unit. The command path
  exposes only single-key and narrow scoped reads ([[domain-entities]]
  `VacationRequestRepository`), keeping the write path lean and letting the
  read side scale independently (a CQRS-leaning split without full CQRS
  machinery).
- **Side-effects decoupled by choreography.** `audit-trail`, `notification`,
  and `overlap-indicator` consume emitted events asynchronously
  ([[business-logic-model]] Outbound domain events), so their scaling is
  independent of the command path and bursts are absorbed by the event
  transport rather than back-pressuring submissions.

## Data Growth & Retention

- **Append-only growth is linear in request count.** Each request contributes a
  small, bounded aggregate (≤ 3 transitions) — [[business-rules]] `BR-INV-4`.
  Total store size grows linearly with the number of requests, not with time or
  activity per request.
- **Seven-year audit retention.** The immutable history feeds the `audit-trail`
  unit, which owns the 7-year retention target (`req-nfr-audit-retention`). This
  unit's obligation is to never delete or mutate history so the retained record
  is complete; long-term archival/tiering of aged records is an `audit-trail` /
  infrastructure concern, not this unit's.
- **Capacity planning input.** Storage sizing = (requests/year) × (avg aggregate
  size) × 7 years + index overhead; the linear, bounded per-request footprint
  makes this projection straightforward for nfr-design / infrastructure-design.

## Scaling Triggers & Limits

- **Scale-out trigger.** Add workflow-service instances when sustained CPU or
  per-instance in-flight command count approaches the sizing threshold (concrete
  autoscaling thresholds are set in nfr-design against the confirmed
  `req-nfr-concurrency` figure).
- **Store-side limit.** The durable append-only store's write IOPS and per-key
  contention are the primary scaling limits; optimistic concurrency
  ([[business-rules]] `BR-INV-3`) keeps per-key contention low because at most
  one approver acts at each stage.
- **No premature sharding.** At the projected volume a single logical store
  partition suffices; `RequestId` sharding is available if growth demands it but
  is not required for MVP.

## Open Items (for nfr-design)

- Replace placeholder concurrency/throughput/headcount figures with the
  quantified target from [[requirements]] `req-nfr-concurrency`.
- Confirm the production append-only store technology and its sharding/retention
  posture jointly with infrastructure-design and the `audit-trail` unit.
