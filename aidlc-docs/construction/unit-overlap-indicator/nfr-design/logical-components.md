# Logical Components — `unit-overlap-indicator`

A component-level view of where this unit's NFR patterns apply — service
boundaries, failure domains, blast radius, isolation, and shared resources. It
bridges the NFR designs (performance-, security-, scalability-, reliability-)
into Infrastructure Design. Grounded in [[tech-stack-decisions]]
(ADR-OVL-01..06), the read-only projection of [[business-logic-model]], the
scaling model of [[scalability-requirements]], the fail-open posture of
[[reliability-requirements]], the budgets of [[performance-requirements]], and
the trust-boundary rules of [[security-requirements]].

The defining structural fact: **this unit is not a deployable component of its
own.** It is an **in-process module embedded in the modular-monolith app tier**
(ADR-OVL-01), owning no datastore, no queue, and no independent runtime. The
inventory below is therefore mostly a map of *consumed* components and the *one*
in-process element this unit contributes.

## Logical Component Inventory

| Component | Kind | Owned? | NFR patterns applied |
|-----------|------|--------|----------------------|
| `OverlapReader` (compute + inbound port) | In-process module in app tier | **Owned** | Timeout, fail-open fallback, O(n) compute budget, PII-free Result. |
| Overlap short-TTL cache | In-process, per-instance memory (ADR-OVL-04) | **Owned** | Cache-aside, ≈10 s TTL, single-flight coalescing, load-shedding. |
| `VacationRequestRepository` read seam | Consumed from `unit-request-workflow` | Consumed (read-only) | Bounded fan-out, inherited connection pooling; wrapped by the 300 ms timeout. |
| `rangesOverlap` / `DateRange` / `RequestStatus` | Consumed value objects (`src/workflow/index.ts`) | Consumed (read-only) | Reused primitive; no duplication (ADR-OVL-05). |
| Session guard (`requireSession`) | Consumed from `unit-platform-auth` | Consumed | SSO-only authN; `401` fail-closed. |
| Permission guard (`requirePermission('request:validate')`) | Consumed from `unit-platform-authz` | Consumed | Server-authoritative authZ; `403` fail-closed (`BR-SCOPE-1`). |
| `<OverlapIndicatorBadge>` on `<RequestReviewCard>` | Consumed UI surface (`unit-request-workflow` frontend) | Consumed | Renders count/degraded state; output-encoded, data-only. |

The only components this unit **owns** are the `OverlapReader` module and its
in-process cache. Everything else is consumed read-only across a published
boundary.

## Service Boundaries & Isolation

- **Boundary: a read-side module, not a service.** The unit sits on the
  side-effect / choreography read side, never on the synchronous command path
  ([[business-logic-model]]). Its public surface is exactly
  `OverlapReader.computeOverlap(requestId)`; it holds no reference to any
  mutating workflow verb (structural isolation, INV-OV-2).
- **Isolation via consumption, not shared state.** It reaches `unit-request-
  workflow` only through the published `src/workflow/index.ts` read surface —
  never internal tables or in-memory structures — preserving the workflow unit's
  boundary and satisfying the "no shared mutable state across boundaries" rule.
- **Auth/authz isolation.** Authentication and authorization are entirely
  external (consumed guards); the unit contributes no trust-boundary logic of its
  own ([[security-requirements]] `BR-SCOPE-1`). This keeps the security-sensitive
  surface concentrated in `unit-platform-auth` / `unit-platform-authz`.
- **Cache isolation.** The short-TTL cache is per-instance and non-authoritative;
  it is a private performance detail of the module, not a shared component, so it
  introduces no cache-coherence coupling as the app tier scales
  ([[scalability-requirements]]).

## Failure Domains & Blast Radius

- **Failure domain: the app-tier instance.** Because the unit is in-process, its
  failure domain is the same app-tier instance that hosts it; it has no separate
  process, host, or datastore to fail independently.
- **Blast radius: a single badge → all badges, never the workflow.** A per-call
  failure degrades one review card's badge; a total module outage degrades every
  badge to "overlap unavailable" while the entire submit/validate/approve path
  keeps working (`REL-OVL-2`, [[reliability-requirements]]). No failure can
  corrupt workflow state, forge audit facts, or block a decision.
- **Failure isolation direction.** Failure flows **inward only** — a degraded
  workflow read seam can make overlap unavailable, but a degraded overlap module
  cannot flow outward to harm the command path (the command path never calls it).
  The 300 ms timeout is the boundary valve that stops a slow seam from consuming
  the lead's latency budget.
- **Fail-open failure mode.** Distinct from the auth guards' fail-closed mode:
  the unit's own compute/read failures fail *open* (advisory absent), while the
  consumed auth/authz guards fail *closed* (`401`/`403`). These two modes are
  intentional and must be preserved in infrastructure wiring.

## Shared Resources & Infrastructure Hand-off

Notes for Infrastructure Design — this unit adds **almost no infrastructure**:

- **No owned datastore, queue, or cache tier** (ADR-OVL-04). Infrastructure need
  not provision any persistent or external-cache resource for this unit; the
  cache is process memory.
- **Shared app-tier compute.** The unit consumes the modular-monolith app tier's
  compute, autoscaling policy, and health checks; it defines no separate scaling
  trigger or health endpoint ([[scalability-requirements]]).
- **Shared read path to the workflow store.** It reuses `unit-request-workflow`'s
  connection pool via the read seam — infrastructure should account for its
  (modest, cache-shed) read volume in the workflow store's pool sizing, but
  provision **no separate connection pool** for overlap.
- **Shared TLS / auth edge.** It rides the platform's TLS-everywhere transport
  and the shared session/permission guards; no new ingress, certificate, or
  secret is required for this unit.
- **Observability hooks.** Emit metrics for `computeOverlap` p95/p99 latency,
  cache hit ratio, timeout/fail-open rate, and the 99.5% degradation-quality SLO
  — PII-free (counts and codes only, `BR-PII-3`). These feed the app tier's
  existing monitoring rather than a dedicated stack.
