# Scalability Design — `unit-status-query`

Concrete scaling solution design for the **Status Tracking & Query** unit — the
read side of the vacation-request modular monolith. It turns the load
projections and strategy in [[scalability-requirements]] into implementable
decisions: the horizontal scaling model, load distribution, the index /
partition strategy for the scoped-queue read, capacity thresholds, and
autoscaling rules. It builds on the guarded-read flows and derived-status model
in [[business-logic-model]], the scope-filtering and pure-read invariants in
[[business-rules]], the stack and read-model choice in [[tech-stack-decisions]],
and coheres with the hot-path budgets in [[performance-requirements]], the
fail-closed availability posture in [[reliability-requirements]], and the
least-privilege read grant in [[security-requirements]].

The scaling premise from [[scalability-requirements]]: growth is a function of
**headcount and seasonal peaks**, not viral or machine traffic. Reads outnumber
writes because status is checked far more often than it changes, but per-request
projection cost is **bounded** (≤ 3 transitions), so total read cost grows with
*concurrency* and *request count*, never with per-request complexity. The chosen
strategy is **stateless horizontal reads over the shared append-only store** —
no separate eventually-consistent read store until read volume actually diverges
from write volume.

## Scaling Architecture

- **SCALE-D-1 — Stateless horizontal scale-out.** `StatusQueryService` holds no
  per-request or session state between calls; every query reads through the
  `VacationRequestRepository` port ([[scalability-requirements]] Scaling Strategy;
  [[performance-requirements]] NFR-SQ-PERF-5). It runs as in-process code inside
  the shared ECS Fargate task the monolith already deploys, so scaling out the
  monolith task count linearly adds read capacity with **no session affinity** and
  no sticky routing — the same posture the shipped `unit-platform-auth`,
  `unit-platform-authz`, and `unit-request-workflow` services use
  ([[tech-stack-decisions]] "adopt the shipped stack").
- **SCALE-D-2 — In-process authorization adds no network fan-out.** The authz
  check is an O(1) in-process grant-table lookup
  ([[scalability-requirements]] "Authorization scales in-process";
  [[performance-requirements]] authz budget ≤ 5 ms), so adding read instances adds
  **zero** authorization-service network load — there is no PDP microservice to
  saturate.
- **SCALE-D-3 — Pure reads are trivially parallel.** No query writes or emits
  events ([[business-rules]] `BR-SQ-15`), so reads take no lock and never
  contend with each other or back-pressure the command path
  ([[scalability-requirements]] "Reads are pure — trivially parallelisable";
  [[performance-requirements]] NFR-SQ-PERF-4). Additional instances add capacity
  linearly.

## Load Distribution

- **SCALE-D-4 — ALB round-robin across stateless instances.** Because instances
  are interchangeable (SCALE-D-1), the shared Application Load Balancer distributes
  read traffic round-robin / least-outstanding-requests across monolith tasks; no
  consistent-hashing or affinity is needed since there is no per-instance cache to
  keep warm at MVP ([[performance-requirements]] PERF-D-4 no-cache decision).
- **SCALE-D-5 — Read/write split without full CQRS machinery.** This unit is the
  query half of a CQRS-leaning split: it reads the **same** append-only store the
  command side writes, via the shared port, as a synchronous on-demand projection
  rather than a separate eventually-consistent copy
  ([[scalability-requirements]] Scaling Strategy; [[business-logic-model]] Design
  Approach; [[tech-stack-decisions]] Read Model). This lets the read side scale its
  instance count independently of write volume while avoiding replication lag and
  rebuild cost at current scale.

## Load Projections (Carried Forward)

Baseline sizing from [[scalability-requirements]] (placeholders pending the
concrete `req-nfr-concurrency` figure, split for reads), used here to derive
thresholds:

| Dimension | Baseline (placeholder) | Growth horizon |
|-----------|------------------------|----------------|
| Concurrent in-flight reads | ≤ 100 peak | 2× headroom; per `req-nfr-concurrency` |
| Aggregate read throughput | ≤ 50 read-req/s peak | 2× headroom |
| Employees (potential readers) | up to a few thousand | 2×–3× over 3 years |
| Timeline size per request | ≤ 3 transitions (bounded) | fixed by the state machine |

Read volume exceeds command-path write volume because status is checked far more
often than it changes ([[scalability-requirements]] Load Projections), but the
bounded timeline keeps per-read work constant ([[performance-requirements]]
NFR-SQ-PERF-1).

## Data Partitioning & Index Strategy

This unit stores nothing ([[business-rules]] `BR-SQ-8/15`); "partitioning" here
means the **access pattern** against the workflow-owned store, and the **index**
that makes the scoped-queue read efficient.

- **SCALE-D-6 — Access is scope-bounded, never a full scan.** Each read touches
  only one owner (`findByOwner`), one key (`findById`), or one department slice
  (`findByDepartmentAndStatus`) — never the whole population
  ([[scalability-requirements]] NFR-SQ-SCALE-2; [[business-rules]] `BR-SQ-5`). So
  as headcount grows, an individual read stays bounded by the caller's scope and
  total cost grows with concurrency, not dataset size.
- **SCALE-D-7 — `(department, status)` secondary index for the queue read.** The
  scoped-queue read (`findByDepartmentAndStatus`) is the one access pattern whose
  cost could grow with department size. The design specifies a secondary index
  keyed on `(department, status)` — on a DynamoDB-class store a GSI with partition
  key `department` and sort key `status` (or a composite) — so the queue read is a
  bounded `Query`, never a scan ([[scalability-requirements]] NFR-SQ-SCALE-5;
  [[performance-requirements]] Query B budget ≤ 200 ms p95). The GSI is provisioned
  against the workflow-owned table but this unit's grant on it remains read-only
  `Query`/`GetItem` ([[security-requirements]] SEC-SQ-5). Whether to build the GSI
  now or defer is confirmed with infrastructure-design against the concrete
  concurrency figure (Open Items).
- **SCALE-D-8 — Store read IOPS is the primary bound.** The shared store's read
  capacity and the efficiency of the `(department, status)` query are the main
  scaling limits ([[scalability-requirements]] NFR-SQ-SCALE-5); the compute tier
  scales cheaply (stateless), so the store read path is watched first.

## Capacity Thresholds & Autoscaling Rules

- **SCALE-D-9 — Compute scale-out trigger.** Scale monolith task count out when
  sustained CPU utilisation exceeds **~65%** or per-instance in-flight read count
  approaches the sizing threshold over a rolling window
  ([[scalability-requirements]] NFR-SQ-SCALE-4). Because this unit is one module of
  the shared task, its autoscaling policy **is** the monolith's — status-query does
  not scale independently of its host, by the modular-monolith design
  ([[tech-stack-decisions]]).
- **SCALE-D-10 — Scale-in guardrail.** Scale in conservatively (longer cooldown
  than scale-out) so seasonal read peaks (start-of-quarter, holiday windows,
  [[scalability-requirements]] context) do not thrash instance count. Target a
  minimum instance floor sized for baseline concurrency with headroom to absorb a
  spike before the scale-out reacts.
- **SCALE-D-11 — Store-capacity signal.** On the store side, alarm on read-throttle
  events / consumed-vs-provisioned read capacity (or DynamoDB on-demand hot-partition
  signals) as the trigger to (a) raise provisioned read capacity or (b) act on the
  deferred materialized-projection option (SCALE-D-12) — a store-tier scaling lever
  the compute autoscaler cannot address ([[scalability-requirements]]
  NFR-SQ-SCALE-5).

The illustrative threshold model below is a pure typed helper — no I/O — capturing
the SCALE-D-9 scale-out decision so it is unambiguous and testable:

```typescript
interface ReadCapacitySignal {
  cpuUtilisation: number; // 0..1
  inFlightReads: number;
  inFlightThreshold: number;
}

type ScaleAction = 'scale-out' | 'hold' | 'scale-in';

// SCALE-D-9/10: scale-out on sustained CPU or in-flight pressure; scale-in only when idle.
function decideScaleAction(s: ReadCapacitySignal): ScaleAction {
  const CPU_OUT = 0.65;
  const CPU_IN = 0.25;
  if (s.cpuUtilisation >= CPU_OUT || s.inFlightReads >= s.inFlightThreshold) {
    return 'scale-out';
  }
  if (s.cpuUtilisation < CPU_IN && s.inFlightReads < s.inFlightThreshold / 4) {
    return 'scale-in';
  }
  return 'hold';
}
```

## Data Growth, Retention & Deferred Options

- **SCALE-D-12 — Materialized projection is a deferred, port-isolated option.** If
  read volume diverges sharply from write volume, the `VacationRequestRepository`
  seam allows swapping in a materialized read projection or a dedicated queue index
  **without changing this unit's public query surface**
  ([[scalability-requirements]] "Materialized projection is a deferred option";
  [[performance-requirements]] PERF-D-6; [[tech-stack-decisions]] Future read
  optimization). Not built now — design-for-change over premature optimization.
- **SCALE-D-13 — No premature sharding or dedicated read store.** At the projected
  volume the synchronous on-demand projection over a single logical store suffices;
  `RequestId`-based sharding or a dedicated read store is available if growth demands
  it but is not required for MVP ([[scalability-requirements]] NFR-SQ-SCALE-6).
- **SCALE-D-14 — Growth and 7-year retention are inherited.** This unit stores
  nothing; the read data grows linearly in request count on the workflow-owned
  append-only store, and the 7-year retention (`req-nfr-audit-retention`) is owned by
  `audit-trail` and the durable store ([[scalability-requirements]] NFR-SQ-SCALE-1/3;
  [[reliability-requirements]] REL-SQ-10). Long-term archival/tiering of aged records
  may make cold-request timelines slower to read — confirmed with infrastructure-design,
  not a correctness concern for this unit.

## Open Items (confirm at infrastructure-design)

- Replace placeholder read-concurrency/throughput/headcount figures with the
  quantified `req-nfr-concurrency` target, split for the read surface, then re-derive
  the SCALE-D-9 thresholds and the minimum instance floor.
- Decide whether to build the `(department, status)` GSI now (SCALE-D-7) or defer it
  until the queue read is measured hot.
- Confirm the cold-read latency impact of long-term retention/archival of aged
  timelines jointly with the `audit-trail` unit (SCALE-D-14).
