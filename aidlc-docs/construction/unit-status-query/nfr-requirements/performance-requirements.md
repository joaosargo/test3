# Performance Requirements — `unit-status-query`

Performance NFRs for the **Status Tracking & Query** unit — the read/query side
of the vacation-request modular monolith. This unit owns no state; it answers
role-scoped, read-only questions ("what is happening with this request, and how
did it get here?") over the append-only `VacationRequest` history that
`unit-request-workflow` owns, guarded by the `unit-platform-authz` PDP. Targets
derive from the three query shapes in [[business-logic-model]] (Queries A/B/C),
the fail-closed authorization ordering and projection rules in
[[business-rules]] (`BR-SQ-1`, `BR-SQ-8`, `BR-SQ-10`), and the response-time /
concurrency NFRs enumerated in [[requirements]] (`req-nfr-availability-tbd`,
`req-nfr-concurrency`, `req-status-tracking`).

This is an internal, human-in-the-loop line-of-business surface: an employee
checks their own request list, a team lead scans a modest work queue, an HR
approver reviews an in-scope department view. Reads are interactive and modest
in volume, not high-throughput machine traffic; because reads are pure
(`BR-SQ-15`, no writes, no events) they are cheap and horizontally scalable. The
envelope is sized for snappy interactive response, consistent with the posture
already shipped in `unit-platform-auth`, `unit-platform-authz`, and
`unit-request-workflow`.

## Response-Time Targets

Latency budgets cover **server-side** query handling only (request received at
the Express handler → response written), excluding client network and browser
render. The path is: `requireSession` (auth) → `requirePermission` (authz,
in-process O(1) grant-table check per the authz `code-summary`) → status-query
service (authorize → load candidates via the `VacationRequestRepository` port →
scope filter → project). No query mutates state or emits events
([[business-rules]] `BR-SQ-15`), so there is no write or event-publish cost on
any path.

| Operation | Target (p95) | Target (p99) | Rationale |
|-----------|--------------|--------------|-----------|
| `listOwnRequests` (Query A) | ≤ 150 ms | ≤ 300 ms | One authz check + single-owner read (`findByOwner`) + in-memory scope filter + projection of a small per-employee set. |
| `listScopedRequests` (Query B) | ≤ 200 ms | ≤ 400 ms | One authz check + `findByDepartmentAndStatus` (or a bounded status union) + `departmentScope` filter + projection of a queue. |
| `getRequestTimeline` (Query C) | ≤ 150 ms | ≤ 300 ms | Single-key `findById` + one authz check + projection of a bounded (≤ 3 accepted transitions) history to `TimelineEntry[]`. |
| Query-path authorization check | ≤ 5 ms | ≤ 10 ms | In-process grant-table Set membership, no network (authz `code-summary`). |
| Aggregate load by id (`findById`) | ≤ 50 ms | ≤ 100 ms | Single-key read from the append-only store. |

- **NFR-SQ-PERF-1 — Bounded projection cost.** A timeline is bounded because the
  source aggregate reaches a terminal state in at most three accepted
  transitions ([[business-logic-model]] Read Model; [[business-rules]]
  `BR-SQ-11`, cross-referencing the workflow unit's `BR-INV-4`), so
  `getRequestTimeline` projection cost is constant per request, not
  usage-dependent.
- **NFR-SQ-PERF-2 — List size is scoped, not global.** `listOwnRequests` returns
  only one employee's requests; a scoped queue returns one team's or one
  department's in-scope rows (`BR-SQ-5`). No query ever materialises the whole
  request population, so response size and time stay bounded by the caller's
  scope.

## Throughput & Concurrency

- **NFR-SQ-PERF-3 — Concurrency target.** The unit must sustain the enterprise's
  expected concurrent read activity on the status surface. Baseline sizing
  assumption (to confirm at nfr-design against the concrete figure in
  [[requirements]] `req-nfr-concurrency`): peak **≤ 100 concurrent in-flight
  reads** and **≤ 50 read-requests/second** aggregate, with headroom to 2×. Reads
  typically outnumber writes for a status surface, so this budget is set higher
  than the workflow unit's command-path budget while remaining modest.
- **NFR-SQ-PERF-4 — No lock contention on reads.** Reads are pure and take no
  lock ([[business-rules]] `BR-SQ-15`, `BR-SQ-17`); a concurrent transition on
  the command side does not block a read, and a read reflects whatever is
  committed at read time. Read latency therefore does not degrade under write
  contention.
- **NFR-SQ-PERF-5 — Stateless service instances.** `StatusQueryService` holds no
  per-request state between calls (all data is read through the repository port),
  so instances scale horizontally behind a load balancer with no session
  affinity — see [[scalability-requirements]].

## Resource & Efficiency Constraints

- **NFR-SQ-PERF-6 — Bounded work per query.** Each query performs at most one
  authorization decision and one repository read (single-key `findById`,
  single-owner `findByOwner`, or a scoped `findByDepartmentAndStatus`), then a
  pure in-memory scope filter and projection. No N+1 reads, no cross-aggregate
  fan-out ([[business-logic-model]] Data Flow).
- **NFR-SQ-PERF-7 — Projection allocates PII-lean shapes.** `RequestSummaryView`
  is a compact row and `RequestTimelineView` a bounded list ([[business-rules]]
  `BR-SQ-9`); projections carry only authorized, PII-safe fields, keeping
  per-response memory and serialization cost small.
- **NFR-SQ-PERF-8 — Read caching is optional, not required.** At the projected
  volume the on-demand synchronous projection is fast enough without a read cache
  ([[business-logic-model]] Design Approach). If read volume ever diverges from
  write volume, the `VacationRequestRepository` port seam allows a materialized
  projection or short-TTL cache to be added behind the port without changing the
  public query surface (cache-aside with strict invalidation is the candidate —
  detailed in [[scalability-requirements]] and nfr-design). Caching is deferred
  deliberately (design-for-change, not premature optimization).

## Measurement & Benchmarks

- Instrument each query with a server-side duration metric (histogram) tagged by
  operation (`listOwnRequests` / `listScopedRequests` / `getRequestTimeline`) and
  outcome (`ok` / error code) so p95/p99 can be tracked against the table above.
  Detailed observability design is owned by [[reliability-requirements]] and
  nfr-design.
- The existing `vitest` suite is the functional-correctness gate. A lightweight
  read smoke (issue N concurrent `listScopedRequests` against one department and
  assert scoping is stable and latency within budget) validates the read path
  without a full load rig; because reads are pure, this smoke has no state-setup
  or teardown cost.

## Open Items (for nfr-design)

- Replace the placeholder concurrency/throughput figures above with the concrete
  target from [[requirements]] `req-nfr-concurrency` once quantified for the read
  surface (reads vs writes split).
- Confirm the p95/p99 read budget against the availability/response-time target
  tracked as `req-nfr-availability-tbd` in [[requirements]].
- Decide with infrastructure-design whether the production read path warrants a
  materialized projection or short-TTL cache, or whether the synchronous
  on-demand projection over the shared store remains sufficient at the confirmed
  volume.
