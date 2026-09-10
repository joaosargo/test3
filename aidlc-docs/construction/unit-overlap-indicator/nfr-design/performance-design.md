# Performance Design — `unit-overlap-indicator`

Concrete performance design for the **Overlap Indicator** — the read-only,
advisory decision aid a team lead sees while reviewing a pending request. This
design realises the targets in [[performance-requirements]]
(`performance-requirements-unit-overlap-indicator`) within the technology
choices fixed by [[tech-stack-decisions]] (ADR-OVL-01..06) and the read-side,
side-effect-free computation described in [[business-logic-model]]
(`computeOverlap`, "pure, stateless projection"). It is bounded by the
scaling posture in [[scalability-requirements]] and must never violate the
fail-open reliability posture in [[reliability-requirements]] nor the PII rules
in [[security-requirements]].

The governing principle from [[performance-requirements]]: this is a
**proportionate, should-have** component off the critical path. Its latency
budget is generous, its throughput modest (it fires once per lead review, not
per page render), and its overriding constraint is that a slow overlap read must
**degrade rather than delay** the lead's decision.

## Latency Budget & Performance Targets

The single hot operation is `OverlapReader.computeOverlap(requestId)`. It does no
I/O of its own beyond the `unit-request-workflow` read seam.

| Metric | Target | Rationale |
|--------|--------|-----------|
| `computeOverlap` server-side p95 | ≤ **150 ms** | Proportionate budget from [[performance-requirements]]; the badge renders well inside the review card's load. |
| `computeOverlap` server-side p99 | ≤ **300 ms** | Equals the fail-open read-timeout ceiling (see Reliability); beyond it we return "unavailable" rather than wait. |
| In-process overlap computation (excluding the workflow read) | ≤ **5 ms** for a department page of ≤ 500 requests | Pure interval-intersection over an in-memory list (ADR-OVL-05); linear in candidate count. |
| Hard read timeout on the workflow seam | **300 ms** | Fail-open boundary; a slower read is abandoned and reported as advisory-unavailable (`BR-ADV-3`). |

These are advisory SLOs, not gates: missing them degrades the badge, never the
workflow command path (`REL` isolation in [[reliability-requirements]]).

## Caching Architecture

Per ADR-OVL-04 in [[tech-stack-decisions]], the unit owns **no datastore** and
keeps only an **in-process short-TTL cache**. The cache exists to shed repeat
reads and to smooth the fan-out described below — never as a system of record
(the workflow store remains authoritative, INV-OV-1).

- **Pattern: cache-aside (lazy).** Key = `(department, competingStatusSet)`;
  value = the department's candidate request list used to compute overlap.
  On miss, read through the workflow seam, populate, return.
- **TTL: short (≈ 10 s), always set.** The indicator is advisory, so a few
  seconds of staleness is acceptable and far cheaper than re-querying on every
  lead keystroke/refresh. A bounded TTL guarantees the cache can never become a
  stale data store (per the caching-invalidation rule: always set a TTL).
- **Request coalescing / single-flight.** Concurrent `computeOverlap` calls for
  the same department collapse to one in-flight workflow read, preventing a
  thundering-herd fan-out when several leads review the same department at once.
- **No negative caching of errors.** A failed read is returned fail-open and is
  **not** cached (a transient blip must not pin "unavailable" for the TTL).
- **Cache scope is per-instance and non-authoritative.** Because the summary is
  recomputed and never persisted (`BR-OV-5`, INV-OV-1), instances need not share
  the cache; horizontal scaling stays trivial (see [[scalability-requirements]]).

## Query & Computation Optimisation

- **Reuse the shipped primitive.** Overlap is computed with the upstream pure
  `rangesOverlap(a, b)` (ADR-OVL-05; [[business-logic-model]]) — no re-derived
  date math, no per-call allocation of a new comparator.
- **Bounded fan-out.** `computeOverlap` reads at most three status buckets
  (`Submitted`, `Validated`, `Approved`) for one department via
  `findByDepartmentAndStatus`; the excluded terminal statuses are never fetched
  (`BR-OV-3`). The cache stores the merged candidate set so the three-bucket
  fan-out happens at most once per TTL per department.
- **Early exit is unnecessary but cheap.** The computation is O(n) in candidate
  count with a trivial constant; for a should-have indicator over a single
  department page this is well within the 5 ms in-process budget and needs no
  indexing or interval tree.
- **Async, non-blocking I/O.** The workflow read is awaited behind the 300 ms
  timeout on Node's event loop (ADR-OVL-01, Node 20); no synchronous blocking,
  so a slow read cannot stall unrelated requests on the same instance.
- **No pagination needed on output.** The summary is a count plus a bounded id
  list for one reviewed request — a small, fixed-shape payload (`OverlapSummary`),
  so there is no large-response streaming or pagination concern.

## Resource & Connection Posture

- **No owned connections.** The unit holds no database or cache client of its
  own; it reaches durable data only through the workflow read seam, inheriting
  that unit's connection pooling. This keeps the overlap indicator's resource
  footprint essentially zero beyond CPU for the intersection loop.
- **In-process only.** The short-TTL cache lives in the app-tier process memory
  and scales in lockstep with the stateless app tier ([[scalability-requirements]]),
  requiring no external cache tier to meet these budgets.
- **Cost of failure is bounded.** If the cache or read is slow, the 300 ms
  timeout caps the resource a single `computeOverlap` can consume before it
  fails open, protecting the app-tier event loop under a degraded workflow seam.
