# Performance Design — `unit-status-query`

Concrete performance solution design for the **Status Tracking & Query** unit —
the read/query side of the vacation-request modular monolith. This document
turns the budgets and constraints enumerated in
[[performance-requirements]] into implementable decisions: the projection hot
path, the (deliberately deferred) caching architecture, resource pooling against
the shared store, async posture, and the measurement plan. It builds on the
guarded-read flows and derived-status invariant in [[business-logic-model]], the
projection/ordering/PII rules in [[business-rules]], the stack chosen in
[[tech-stack-decisions]], and stays coherent with the fail-closed reliability
posture in [[reliability-requirements]], the scoped-read scaling model in
[[scalability-requirements]], and the non-leaking PII rules in
[[security-requirements]].

The governing fact from [[performance-requirements]] is that reads here are
**pure, scope-bounded, and modest in volume** — an employee glancing at their
own list, a lead scanning a queue, HR reviewing a department view. There is no
write, event, or lock cost on any path ([[business-rules]] `BR-SQ-15/17`), so the
performance work is about keeping the synchronous projection cheap and the store
access efficient, not about defeating high-throughput machine load.

## Hot-Path Design & Performance Budgets

The server-side query path is fixed by [[business-logic-model]] (Data Flow) and
its budget by [[performance-requirements]] (Response-Time Targets):

```
requireSession (auth, in-process)
  → requirePermission (authz, in-process O(1) grant-table check)
    → StatusQueryService.<query>
        → VacationRequestRepository read (findById | findByOwner | findByDepartmentAndStatus)
        → in-memory scope filter (BR-SQ-5)
        → projection → RequestSummaryView[] | RequestTimelineView
```

Budgets carried forward verbatim from [[performance-requirements]] as the
design's acceptance targets:

| Operation | p95 | p99 | Design lever |
|-----------|-----|-----|--------------|
| `listOwnRequests` (Query A) | ≤ 150 ms | ≤ 300 ms | Single-owner `findByOwner`, bounded per-employee set, pure projection. |
| `listScopedRequests` (Query B) | ≤ 200 ms | ≤ 400 ms | `findByDepartmentAndStatus` served by a `(department, status)` index (see Scalability); bounded queue projection. |
| `getRequestTimeline` (Query C) | ≤ 150 ms | ≤ 300 ms | Single-key `findById`; bounded ≤ 3-transition timeline projection ([[business-rules]] `BR-SQ-11`). |
| Authorization check | ≤ 5 ms | ≤ 10 ms | In-process grant-table `Set` membership — no network. |
| Aggregate load (`findById`) | ≤ 50 ms | ≤ 100 ms | Single-key read against the shared store. |

- **PERF-D-1 — Bounded projection is constant-cost.** Because a request reaches a
  terminal state in at most three accepted transitions
  ([[performance-requirements]] NFR-SQ-PERF-1; [[business-rules]] `BR-SQ-11`),
  `getRequestTimeline` projection cost is O(1) in transitions, not
  usage-dependent. The timeline projection is a pure map over `history` with a
  role-gated `reason` decision per entry ([[business-rules]] `BR-SQ-6`); no
  sorting beyond the store's already-ordered append log.
- **PERF-D-2 — Scoped, never global reads.** No query materialises the whole
  request population ([[performance-requirements]] NFR-SQ-PERF-2;
  [[business-rules]] `BR-SQ-5`). Response size and CPU stay bounded by the
  caller's scope (one owner / one team / one department).
- **PERF-D-3 — One authz decision + one store read per query.** The design
  forbids N+1 reads and cross-aggregate fan-out
  ([[performance-requirements]] NFR-SQ-PERF-6): each query issues exactly one
  `AuthzService.decide` and one repository call, then works in memory.

## Caching Architecture (Deferred, Port-Isolated)

[[performance-requirements]] NFR-SQ-PERF-8 makes read caching **optional, not
required** at MVP volume, and [[tech-stack-decisions]] defers it behind the
`VacationRequestRepository` port. This design records the *decision to defer* and
the *shape it would take* so the seam is honoured, per the cache-placement matrix
in the NFR-design guide.

- **PERF-D-4 — No cache at MVP.** The synchronous on-demand projection over the
  shared store is fast enough at the projected volume
  ([[scalability-requirements]] Load Projections). A cache is not built now
  (design-for-change, not premature optimization), matching the tradeoff recorded
  in the [[performance-requirements]] and [[scalability-requirements]] Open Items.
- **PERF-D-5 — If added later: cache-aside behind the port, strict TTL +
  event-driven invalidation.** The only correctness-safe pattern against the
  strongly-consistent append-only store ([[business-rules]] `BR-SQ-17`;
  [[reliability-requirements]] REL-SQ-7) is cache-aside with a **short TTL** and
  **invalidation driven by the workflow unit's transition events** on the shared
  bus. The candidate placement, per the NFR-design cache matrix:

| Candidate cache | Location | TTL | Invalidation |
|-----------------|----------|-----|--------------|
| Timeline / status by `requestId` | Application-level (Redis-class), behind the port | Short (30–60 s) | Event-driven purge on `Request*` transition events keyed by `requestId`. |
| Scoped queue result set | Application-level, behind the port | Very short (10–30 s) | Purge the department key on any `Request*` event for that department. |

  A cached view MUST NOT outlive a committed transition it does not reflect; TTL
  is the backstop, event-purge is the primary. Never cache an error/deny outcome
  ([[security-requirements]] fail-closed) and never cache across principals — a
  cache key includes the authorization scope so a hit can never widen access
  ([[business-rules]] `BR-SQ-5`; [[security-requirements]] SEC-SQ-4).
- **PERF-D-6 — Materialized read projection is the higher-volume alternative.** If
  read volume diverges sharply from write volume, a materialized queue projection
  (or a dedicated `(department, status)` read index) replaces the cache — also
  behind the same port, no public-surface change
  ([[scalability-requirements]] NFR-SQ-SCALE-5). Chosen only against measured
  divergence, not up front.

## Resource Pooling & Store Access

- **PERF-D-7 — Reuse the shared store connection pool; add no new pool.** This
  unit holds no store credentials and opens no new connection — it reads through
  the `VacationRequestRepository` port that the workflow unit already wires
  ([[tech-stack-decisions]] "no new persistence, no new port"). Against the
  production DynamoDB-class store the SDK client is a shared, long-lived,
  keep-alive HTTP client; against a SQL-class store the design inherits the
  workflow unit's connection pool. Pool sizing follows the NFR-design formula
  `pool = rps × avg_duration_s × 1.5`; at the [[scalability-requirements]]
  placeholder of ≤ 50 read-req/s and ≤ 100 ms reads this is a small pool
  (~8 connections) — but the number is the shared pool's, not a second pool this
  unit introduces.
- **PERF-D-8 — Read-only least-privilege access.** The store grant is
  `Query`/`GetItem` only, never write ([[security-requirements]] SEC-SQ-5;
  workflow shared-infrastructure single-writer rule), so read access can never
  contend with the command path's write capacity beyond consuming read IOPS.

## Async & Concurrency Posture

- **PERF-D-9 — Node.js non-blocking I/O, no worker offload.** Each query is a
  single `await`ed store read plus synchronous in-memory projection on the event
  loop ([[tech-stack-decisions]] Node ≥ 20). The projection is O(1)–O(scope) CPU
  and never blocks meaningfully; no worker-thread or queue offload is warranted
  ([[performance-requirements]] NFR-SQ-PERF-6).
- **PERF-D-10 — No lock, no write contention.** Reads take no lock
  ([[performance-requirements]] NFR-SQ-PERF-4; [[business-rules]] `BR-SQ-15/17`),
  so a concurrent command-side transition never blocks a read and read latency
  does not degrade under write contention. Reads are trivially parallel across
  the async runtime and across instances ([[scalability-requirements]]
  Scaling Strategy).
- **PERF-D-11 — Stateless service instances.** `StatusQueryService` keeps no
  per-request state between calls ([[performance-requirements]] NFR-SQ-PERF-5),
  so pagination/continuation (if a scoped list ever grows large enough to need
  it) is stateless cursor-based, carried in the request, never server-held.

## Projection Efficiency

- **PERF-D-12 — PII-lean shapes minimise serialization cost.**
  `RequestSummaryView` is a compact row and `RequestTimelineView` a bounded list
  ([[performance-requirements]] NFR-SQ-PERF-7; [[business-rules]] `BR-SQ-9`);
  projections carry only authorized, PII-safe fields, so per-response allocation
  and JSON serialization stay small. The role-gated `reason` omission
  ([[business-rules]] `BR-SQ-6`; [[security-requirements]] SEC-SQ-8) also trims
  payload for unentitled callers.
- **PERF-D-13 — Server-defined ordering, no client re-sort.** Ordering is applied
  once, server-side, per [[business-rules]] `BR-SQ-10` (my-list/HR by
  `lastUpdatedAtMs` desc; lead queue by `submittedAtMs` asc). Sort cost is
  O(scope · log scope) over a bounded set — negligible at projected volume.

The illustrative projection below is the constant-cost timeline map referenced by
PERF-D-1; it is a pure function with no I/O, typed against the read model in
[[business-logic-model]]:

```typescript
interface Transition {
  from: string;
  to: string;
  stage?: string;
  atMs: number;
  reason?: string;
}

interface TimelineEntry {
  from: string;
  to: string;
  stage?: string;
  atMs: number;
  reason?: string;
}

// Pure, O(history) projection — no store call, no lock (PERF-D-1, BR-SQ-6/11).
function projectTimeline(
  history: readonly Transition[],
  maySeeReason: boolean,
): TimelineEntry[] {
  return history.map((t): TimelineEntry => {
    const entry: TimelineEntry = {
      from: t.from,
      to: t.to,
      stage: t.stage,
      atMs: t.atMs,
    };
    // Role-gated: reason is OMITTED (not placeheld) when not entitled.
    if (maySeeReason && t.reason !== undefined) {
      entry.reason = t.reason;
    }
    return entry;
  });
}
```

## Measurement & Benchmarks

- **PERF-D-14 — Per-operation latency histograms.** Instrument each query with a
  server-side duration histogram tagged by operation
  (`listOwnRequests`/`listScopedRequests`/`getRequestTimeline`) and outcome
  (`ok`/error code) so p95/p99 track against the budget table
  ([[performance-requirements]] Measurement & Benchmarks). Metrics feed the shared
  CloudWatch/X-Ray plane the monolith already runs (workflow infrastructure
  monitoring-design).
- **PERF-D-15 — Read smoke as the lightweight load gate.** A read smoke — issue N
  concurrent `listScopedRequests` against one department, assert stable scoping
  and in-budget latency — validates the read path without a full load rig; since
  reads are pure there is no state setup/teardown ([[performance-requirements]]
  Measurement & Benchmarks). The `vitest` suite ([[tech-stack-decisions]]) remains
  the functional-correctness gate.
- **PERF-D-16 — Budget-breach alarm.** Alarm when p95 for any operation exceeds
  its target for a sustained window; this is the trigger to revisit the deferred
  cache/materialized-projection decision (PERF-D-5/6) against measured data rather
  than speculation.
