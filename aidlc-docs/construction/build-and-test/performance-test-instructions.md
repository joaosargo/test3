# Performance Test Instructions — Vacation Request App

Owner: aidlc-quality-agent (performance specialist). Warranted because units
ship `performance-requirements` NFRs (latency and concurrency targets, e.g.
`req-nfr-concurrency`, `req-nfr-availability-tbd`). Grounded in the per-unit
performance-requirements / performance-design NFRs and the [[code-summary]]
hot-path notes; the auth unit's [[code-generation-plan]] fixes in-process
stateless session-token validation on the hot path.

> **Scope note.** These instructions define the load-test approach and the
> target-vs-actual matrix to execute during the **performance-validation**
> stage (Operation phase) against a production-like environment. They are **not**
> run in the unit CI gate — no live infra exists in the build-and-test sandbox,
> so no load run is executed here. Latency-sensitive logic (stateless token
> verification, in-memory revocation lookup) is instead guarded functionally by
> the unit suite.

## Tooling

- **k6** (preferred for API load testing) or **Artillery** for quick YAML-driven
  scenarios. Locust if complex user-behaviour modelling is needed.
- Metrics from the target environment's monitoring (per the per-unit
  `monitoring-design`): latency percentiles, throughput, error rate, resource
  utilisation.

## Methodology

1. Identify critical journeys: SSO login/callback, submit request, team-lead
   validate, HR approve, status query, audit read.
2. Script realistic scenarios with think times and parameterised data
   (pseudonymous ids only — no PII in load data).
3. Establish a baseline on a staging environment that mirrors production
   (instance sizes, data volume, topology).
4. Run against production-like infra; compare to NFR targets; find bottlenecks.

## Test design patterns

- **Ramp-up** — 0 → target virtual users over 5–15 min; find the breaking point.
- **Steady-state** — hold expected peak 30–60 min; catch leaks / pool
  exhaustion (session store, event bus, repository connections).
- **Spike** — 3–5× normal for 2–5 min; validate graceful degradation and any
  auto-scaling triggers.
- **Soak** — 60–80% peak for 4–24 h; catch slow leaks and handle exhaustion.

## Metrics & percentiles

- Report **percentiles, not averages**: p50 (typical), p95 (primary SLO), p99
  (tail), and p99.9 for high-volume read paths (status/audit queries).
- Report throughput (RPS) alongside latency; identify the RPS ceiling where
  latency degrades past target.
- The auth hot path (stateless token verify) should show flat p95 under load
  because it does no store round-trip — assert no per-request store latency
  creeps in.

## NFR target-vs-actual matrix (fill during performance-validation)

| NFR | Target | Actual | Status | Test Date | Notes |
|-----|--------|--------|--------|-----------|-------|
| Login callback p95 | (from perf-requirements) | — | PENDING | — | includes IdP round-trip |
| Session verify p95 (hot path) | (from perf-design) | — | PENDING | — | in-process, no store hit |
| Submit request p95 | (from perf-requirements) | — | PENDING | — | authz + persist + publish |
| Status query p95 | (from perf-requirements) | — | PENDING | — | read path |
| Audit read p95 | (from perf-requirements) | — | PENDING | — | chained read |
| Sustained throughput | `req-nfr-concurrency` target | — | PENDING | — | steady-state |
| Availability | `req-nfr-availability-tbd` | — | PENDING | — | 30-day measurement |

## How to run (in performance-validation)

```bash
k6 run perf/login.js         # scripted per critical journey
k6 run perf/submit.js
k6 run perf/status-query.js
```

Regression detection: gate on >10% p95 degradation versus the recorded baseline.
