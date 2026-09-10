# Reliability Design — `unit-status-query`

Concrete reliability solution design for the **Status Tracking & Query** unit —
the read/query side of the vacation-request modular monolith. It turns the SLOs,
fail-closed rules, and degradation tiers in [[reliability-requirements]] into
implementable resilience patterns: timeout/retry configuration, the (absent)
circuit-breaker rationale, health checks, the graceful-degradation model,
failover, and the (inherited) backup posture. It builds on the guarded-read flows
in [[business-logic-model]], the fail-closed and derived-status rules in
[[business-rules]], the stack and read-model choice in [[tech-stack-decisions]],
and coheres with the fail-closed authorization design in [[security-requirements]],
the stateless scale model in [[scalability-requirements]], and the latency budgets
in [[performance-requirements]].

The reliability premise from [[reliability-requirements]]: because this unit owns
no state, emits no events, and takes no locks, its concerns are simpler than the
command path's. Reliability here means **failing closed on dependencies**, **never
returning data the caller is not entitled to even under failure**, and **always
reflecting committed truth**. A status view that shows another role's data, or
that lingers stale after a transition, is a *correctness* failure, not merely an
availability one.

## Availability SLO & Error Budget

- **REL-D-1 — 99.9% read-path availability (placeholder).** Target 99.9% monthly
  availability for the status-read path (own list / scoped queue / timeline),
  measured as `successful_or_expected-error_responses / total_requests` — a
  well-formed `err(forbidden|notFound|invalidInput)` counts as **available**
  because the service responded correctly ([[reliability-requirements]] REL-SQ-1;
  [[business-rules]] `BR-SQ-1/4/12`). 99.9% ≈ 43 min/month error budget; the
  concrete figure replaces this placeholder once `req-nfr-availability-tbd` is
  quantified (Open Items).
- **REL-D-2 — Availability rides on shared infrastructure.** Because reads are
  stateless and pure, availability is bounded by the auth/authz in-process calls,
  the shared append-only store's read availability, and the process itself; this
  unit adds no new stateful dependency of its own
  ([[reliability-requirements]] REL-SQ-2; [[scalability-requirements]]
  SCALE-D-1). Its availability is therefore ≈ the monolith's availability minus
  store-read faults.

## Resilience Patterns

The applicable patterns from the NFR-design guide, scoped to a pure read surface:

| Pattern | Applied? | Configuration / rationale |
|---------|----------|---------------------------|
| Timeout | **Yes** | Bounded store-read timeout (see REL-D-3). Every external call gets a timeout. |
| Retry with backoff | **Yes (bounded, safe)** | Reads are idempotent (`BR-SQ-15`), so a store read is safely retryable — REL-D-4. |
| Fail-closed (deny) | **Yes** | Auth/authz/store failure → typed error, never permissive data — REL-D-5/6/7. |
| Circuit breaker | **Not at MVP** | Auth/authz are in-process (no network to trip); store read has one hop — REL-D-8. |
| Bulkhead | **Inherited** | The monolith's shared task is the bulkhead boundary; no per-dependency pool here — REL-D-9. |
| Fallback / cached data | **No** | No advisory data on the read path; a stale/fabricated view is a correctness failure — REL-D-10. |

- **REL-D-3 — Store-read timeout.** The `VacationRequestRepository` read is issued
  with a bounded timeout aligned to the [[performance-requirements]] `findById`
  budget (≤ 100 ms p99) with margin — a **read timeout of ~800 ms** (consistent
  with the read-through timeout posture the sibling `unit-hris-balance` uses) after
  which the query returns a retryable `err` rather than hanging the request. No
  partial or fabricated data is ever returned ([[reliability-requirements]]
  REL-SQ-5).
- **REL-D-4 — Bounded retry with jitter, only on transient store faults.** On a
  timeout or transient store error the design permits **at most 2 retries** with
  exponential backoff + jitter (e.g. 50 ms, 100 ms + jitter). Retries are safe
  because reads are idempotent and side-effect-free
  ([[reliability-requirements]] REL-SQ-5; [[business-rules]] `BR-SQ-15`). Retries
  are **never** applied to a `forbidden`/`notFound`/`invalidInput` outcome — those
  are correct terminal answers, not transient faults.
- **REL-D-8 — No circuit breaker at MVP, by design.** Auth and authz are in-process
  library calls, not network services, so there is no downstream to trip a breaker
  for ([[business-logic-model]] Data Flow; [[scalability-requirements]] SCALE-D-2).
  The single store hop is guarded by timeout + bounded retry (REL-D-3/4); a breaker
  is the deferred escalation if the store read ever shows sustained failure under
  load, added behind the port with the cache/materialized-projection option
  ([[performance-requirements]] PERF-D-5/6). Recorded as a reversible decision.
- **REL-D-9 — Bulkhead is the shared task boundary.** This unit is one module in the
  shared ECS Fargate task ([[scalability-requirements]] SCALE-D-1); it introduces no
  dedicated thread/connection pool, so isolation is at the task/instance level — a
  status-query fault cannot exhaust a pool that starves the command path, because it
  holds no pool of its own ([[performance-requirements]] PERF-D-7).

## Fail-Closed Behaviour

- **REL-D-5 — Fail-closed on the authz dependency.** If the authz PDP cannot render
  a decision, the read **denies** (`err(forbidden)`) rather than returning data
  ([[reliability-requirements]] REL-SQ-3; [[security-requirements]] SEC-SQ-2;
  [[business-rules]] `BR-SQ-1/3`), consistent with the authz unit's
  `DIRECTORY_UNAVAILABLE → deny` posture and the workflow unit's `REL-WF-3`.
- **REL-D-6 — Fail-closed on the session dependency.** No valid session → `401` via
  `requireSession`; the read path is unavailable to an unauthenticated caller by
  design ([[reliability-requirements]] REL-SQ-4; [[business-logic-model]] Data
  Flow) — a deliberate fail-closed, not an outage.
- **REL-D-7 — Expected failures are values, not exceptions.** Authorization denials,
  unknown ids, and invalid input return `Result.err` with a PII-free code
  ([[reliability-requirements]] REL-SQ-6; [[tech-stack-decisions]] `Result<T,E>`);
  throwing is reserved for programmer error / misconfiguration, so transient
  business failures never crash the process.

## Consistency & Correctness Under Failure

- **REL-D-11 — Reads reflect committed truth.** The read model is a synchronous
  on-demand projection over the same append-only store the command side writes, so a
  projection reflects every transition committed at read time — no read-your-writes
  gap for the vacation domain's scale ([[reliability-requirements]] REL-SQ-7;
  [[business-rules]] `BR-SQ-17`; [[scalability-requirements]] SCALE-D-5). This is why
  a fallback cache is rejected (REL-D-10): a cache could show state older than a
  committed transition.
- **REL-D-12 — Status can never disagree with history.** Current `status` is the
  `to` of the latest `Transition`, read through the port
  ([[reliability-requirements]] REL-SQ-8; [[business-rules]] `BR-SQ-8`); state and
  history are the same data read two ways, structurally incapable of drift.
- **REL-D-13 — Non-leaking failure semantics under all outcomes.** Whether a request
  is missing, terminal, or out of scope, the `notFound`/`forbidden` posture never
  confirms existence to an unauthorized caller
  ([[reliability-requirements]] REL-SQ-9; [[security-requirements]] SEC-SQ-6;
  [[business-rules]] `BR-SQ-4`) — correct behaviour under the "unauthorized asks for
  a real id" mode is a reliability requirement, not only a security one.

## Health Checks

- **REL-D-14 — Shallow liveness via the shared task probe.** Liveness is the
  monolith task's existing shallow HTTP check (process up, event loop responsive);
  this unit adds no separate liveness endpoint ([[scalability-requirements]]
  SCALE-D-1 shared task).
- **REL-D-15 — Readiness reflects the store-read dependency.** The unit contributes
  to the shared readiness probe by confirming it can perform a cheap, unauthenticated
  store connectivity check (e.g. a bounded describe/ping through the port) — because
  the store read is this unit's only external dependency
  ([[reliability-requirements]] REL-SQ-2). It does **not** health-check auth/authz
  separately: they are in-process, so their health is the process's health. A failing
  store-connectivity check marks the task unready so the ALB (SCALE-D-4) drains it.

## Graceful Degradation

Dependency-to-tier mapping, carried from [[reliability-requirements]] and made
actionable:

| Dependency | Tier | Degradation behaviour |
|-----------|------|-----------------------|
| Auth session (`unit-platform-auth`) | Critical | No session → 401; read path unavailable by design (fail-closed, REL-D-6). |
| Authz PDP (`unit-platform-authz`) | Critical | Cannot decide → `err(forbidden)` (deny), never data (REL-D-5). |
| Shared request store (`unit-request-workflow`) | Critical | Read fails/times out → retryable `err`, no stale/fabricated view (REL-D-3/4). |
| Optional read cache / materialized projection (future) | Advisory | Miss/down → fall through to the on-demand projection over the store; correctness unaffected (REL-D-10; [[performance-requirements]] PERF-D-5/6). |

- **REL-D-16 — No advisory data on the read path.** Unlike the command path (where
  HRIS balance and overlap are advisory), the status surface either authoritatively
  shows in-scope committed data or returns a typed error
  ([[reliability-requirements]] Graceful Degradation). There is no partial-render
  degraded mode — that would risk showing an incorrect status.

## Failure-Mode Checklist

- **Authz PDP unavailable** → `err(forbidden)`; no data (REL-D-5).
- **Store read times out** → bounded retry, then retryable `err`; caller may safely
  retry (REL-D-3/4).
- **Unauthorized caller requests a real id** → non-leaking `notFound`/`forbidden`
  (REL-D-13; [[business-rules]] `BR-SQ-4`).
- **Concurrent transition during a read** → read reflects whatever is committed at
  read time; no lock, no torn read (REL-D-11/12; [[business-rules]] `BR-SQ-17`).
- **Invalid query input** → `err(invalidInput, <field>)`, no read attempted
  ([[business-rules]] `BR-SQ-12/13/14`).
- **Blast radius** → a status-query fault affects only in-flight reads on that
  instance (stateless; clients retry on another instance via the ALB); it cannot
  corrupt persisted state because the unit performs no writes
  ([[reliability-requirements]] Failure-Mode Checklist; [[business-rules]]
  `BR-SQ-15`).

## Failover

- **REL-D-17 — Instance failover is stateless retry.** Because instances are
  interchangeable and hold no session state (SCALE-D-1), failover on an instance
  fault is simply the ALB routing the retry to a healthy task — no state handoff, no
  warm-up ([[reliability-requirements]] REL-SQ-2). Multi-AZ posture is inherited from
  the shared monolith deployment (workflow deployment-architecture).

## Backup & Recovery

- **REL-D-18 — No durability obligation of its own.** The unit persists nothing
  ([[reliability-requirements]] REL-SQ-10; [[business-rules]] `BR-SQ-15`);
  durability, backup, and point-in-time recovery of the underlying append-only
  history are owned by `unit-request-workflow` (`REL-WF-8/9`) and the `audit-trail`
  retention requirement (`req-nfr-audit-retention`). After any store restore, this
  unit's projections are **immediately correct** because they are derived on demand
  from the restored history (REL-D-11/12) — there is no read-model to rebuild.

## Open Items (confirm at infrastructure-design)

- Replace the 99.9% placeholder (REL-D-1) with the concrete availability /
  response-time target from `req-nfr-availability-tbd`.
- Confirm the read availability contributed by the shared store and whether read
  replicas are warranted at the confirmed volume ([[reliability-requirements]] Open
  Items; [[scalability-requirements]] SCALE-D-8).
- Confirm the store-read timeout (REL-D-3) and retry budget (REL-D-4) against the
  production store's measured latency distribution.
