# Scalability Design — `unit-overlap-indicator`

Concrete scalability design for the **Overlap Indicator**. It realises the
scaling posture in [[scalability-requirements]]
(`scalability-requirements-unit-overlap-indicator`) using the stateless,
in-process approach fixed by [[tech-stack-decisions]] (ADR-OVL-01, ADR-OVL-04,
ADR-OVL-05) and the read-only projection defined in [[business-logic-model]].
It stays within the fail-open reliability boundary of
[[reliability-requirements]], the latency budget of [[performance-requirements]],
and the PII limits of [[security-requirements]].

The core scaling fact from [[scalability-requirements]]: this unit has **no
write-scaling dimension**. It owns no state, so scalability is purely a matter
of **read throughput and load-shedding from the workflow store**, and it scales
**in lockstep with the modular-monolith app tier** rather than as an independent
tier.

## Scaling Architecture

- **Stateless, horizontal, in-lockstep.** The unit is a pure read-side
  projection (INV-OV-1) embedded in the app-tier process (ADR-OVL-01). Adding an
  app-tier instance adds overlap-read capacity linearly; there is nothing to
  shard, replicate, or coordinate. No session affinity is required because the
  per-instance short-TTL cache is non-authoritative and any instance can serve
  any request.
- **No independent scaling unit.** Because it consumes `unit-request-workflow`'s
  read seam and holds no store, it never needs to scale ahead of or behind the
  app tier. Capacity planning for this unit reduces to "does the app tier have
  enough instances?" — already governed by the workflow unit's scaling plan.
- **Vertical scaling is a non-issue.** The in-process computation is O(n) over a
  single department's candidate list with a ≤ 5 ms budget
  ([[performance-requirements]]); no single call is CPU-heavy enough to warrant
  vertical scaling for this unit specifically.

## Load Profile & Throughput

- **Invocation frequency is low and bounded.** `computeOverlap` fires **once per
  lead review**, not per page render or per employee action, so its request rate
  is a small fraction of the overall app tier's load (a should-have decision aid,
  per [[scalability-requirements]]). Peak load tracks the number of team leads
  concurrently reviewing requests — modest for an internal daily-use tool.
- **Read fan-out is the real cost.** Each cache-miss read fans out to three
  status buckets for one department via `findByDepartmentAndStatus`. The scaling
  concern is therefore **protecting the workflow store from redundant reads**,
  not raw overlap-compute throughput.
- **Throughput target is proportionate.** Sustained overlap-read throughput is
  sized to the concurrent-lead-review rate with generous headroom; there is no
  need to design for the ~500-concurrent-user platform ceiling on this path,
  since only leads-in-review hit it.

## Load Shedding & Data Access at Scale

- **Short-TTL cache sheds repeat reads** (per [[performance-requirements]] and
  ADR-OVL-04). Under a burst of reviews within the same department, the ≈ 10 s
  TTL collapses repeated reads to one workflow query per department per window,
  directly shedding load from the workflow store — the primary scale lever for a
  read-only adapter (mirroring the load-shedding intent in
  [[scalability-requirements]]).
- **Single-flight coalescing** collapses concurrent same-key misses into one
  in-flight read, preventing a cache-stampede fan-out when several leads open the
  same department simultaneously.
- **Bounded, degradation-safe backpressure.** If the workflow read seam is
  saturated, the 300 ms fail-open timeout ([[reliability-requirements]]) sheds
  the overlap read entirely — the badge shows "unavailable" and the lead
  proceeds. Overlap load can therefore never contribute to a cascading overload
  of the command path; it self-sheds first.
- **No cross-instance coordination.** Per-instance caches mean no distributed
  cache tier, no cache-coherence traffic, and no shared-state bottleneck as the
  app tier scales out — consistent with the stateless read-scaling model in
  [[scalability-requirements]].

## Capacity Thresholds & Growth

- **Growth dimension: department size and review concurrency.** The only inputs
  that grow the per-call cost are (a) the number of competing requests in a
  department and (b) the number of concurrent reviews. Both grow slowly for an
  internal tool; the O(n) compute and short-TTL cache absorb realistic growth
  without redesign.
- **Threshold to revisit.** If a department's competing-request count or the
  concurrent-review rate ever pushes `computeOverlap` p99 toward the 300 ms
  fail-open ceiling, the documented next step (from the functional-design
  tradeoffs) is an **event-materialized overlap projection** fed by
  `RequestSubmitted`/transition events — trading added complexity for O(1)
  reads. This is explicitly deferred; the current design is sized for the
  should-have scope.
- **No auto-scaling rules of its own.** The unit inherits the app tier's
  auto-scaling policy; it defines no separate scaling trigger because it has no
  independent resource dimension (per [[scalability-requirements]]).
