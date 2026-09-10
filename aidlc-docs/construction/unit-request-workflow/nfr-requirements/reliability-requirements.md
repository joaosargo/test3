# Reliability Requirements — `unit-request-workflow`

Reliability NFRs for the **Vacation Request Workflow** unit — availability,
fault tolerance, consistency, degradation, and recovery for the command-path
core. Targets derive from the fail-closed transition guards and
same-logical-commit event rule in [[business-logic-model]] (Workflows A/B/C,
Data Flow), the concurrency and append-only invariants in [[business-rules]]
(`BR-INV-3/4/5`, `BR-WF-6/7`), and the availability and audit NFRs in
[[requirements]] (`req-nfr-availability-tbd`, `req-immutable-audit-trail`,
`req-nfr-audit-retention`).

The unit is the transactional heart of the application — an approval that is
lost, duplicated, or silently unaudited is a correctness failure, not merely a
performance one. Reliability requirements therefore emphasise **consistency and
durability of state transitions** over raw uptime, while still targeting the
availability the business needs for a daily-use internal tool.

## Availability Targets (SLO)

- **REL-WF-1 — Command-path availability.** Target **99.9%** monthly
  availability for the write path (submit / validate / approve / reject),
  measured as `successful_or_expected-error_responses / total_requests` (a
  well-formed `err(forbidden|invalidInput|illegalTransition|staleState)` counts
  as available — the service responded correctly). This is a placeholder pending
  the concrete figure tracked as `req-nfr-availability-tbd` in [[requirements]]
  (see Open Items); 99.9% ≈ 43 min/month error budget.
- **REL-WF-2 — Graceful dependency isolation.** Availability of the command path
  is **not** coupled to the availability of advisory dependencies. If
  `unit-hris-balance` (display-only balance) or `overlap-indicator` are down,
  `submitRequest` still succeeds ([[business-logic-model]] "Balance … advisory
  only"; [[business-rules]] `BR-VAL-6`) — those are decision aids, not gates.
- **REL-WF-3 — Fail-closed on auth/authz dependency.** If the authz PDP cannot
  render a decision, the command **denies** (`err(forbidden)`) rather than
  allowing — reliability here means failing safe, consistent with the authz
  unit's `DIRECTORY_UNAVAILABLE → deny` posture ([[business-rules]] `BR-WF-7`).

## Consistency & Fault Tolerance

- **REL-WF-4 — Atomic transition + event.** The state change and its domain
  event are emitted in the **same logical commit** ([[business-logic-model]]
  Design Approach; [[business-rules]] `BR-INV-5`), so no accepted transition can
  be persisted without its event, and no event can fire without the state
  change — the source of the immutable audit record is never out of sync with
  the aggregate.
- **REL-WF-5 — Lost-update prevention.** Optimistic concurrency
  ([[business-rules]] `BR-INV-3`): a transition supplies `expectedVersion`; a
  mismatch returns `err(staleState)` and writes nothing. Concurrent approvers
  cannot both commit; the loser re-reads and retries. This is the primary
  fault-tolerance mechanism against double-approval.
- **REL-WF-6 — Idempotent-safe retries.** Because every accepted transition
  increments `version` monotonically ([[business-rules]] `BR-INV-2`) and guards
  are state-preconditioned (`BR-WF-2/6`), a client retry after an ambiguous
  outcome is safe: if the first write actually committed, the retry fails the
  version/state guard (`staleState` / `illegalTransition`) instead of applying a
  second transition.
- **REL-WF-7 — Expected failures are values, not exceptions.** Validation
  errors, illegal transitions, denials, and stale-state conflicts return
  `Result.err` with a PII-free code and leave state unchanged
  ([[business-logic-model]] Error handling; [[domain-entities]]
  `WorkflowError`). Throwing is reserved for programmer error / misconfiguration,
  so transient business failures never crash the process.

## Durability, Backup & Recovery

- **REL-WF-8 — Durable append-only persistence.** Production wires a durable
  append-only store behind `VacationRequestRepository` ([[domain-entities]]);
  the in-memory adapter is dev/test only. Committed transitions survive process
  restart and instance loss.
- **REL-WF-9 — Point-in-time recoverability.** The durable store must support
  backup / point-in-time recovery consistent with the 7-year retention the
  `audit-trail` unit requires (`req-nfr-audit-retention`). Because history is
  append-only ([[business-rules]] `BR-INV-4`), recovery restores a consistent
  ordered timeline with no in-place-edit reconciliation.
- **REL-WF-10 — Reconstructable current state.** Current `status` is a derived
  projection of the latest transition ([[business-rules]] `BR-INV-4`), so state
  and history can never disagree and the aggregate is fully reconstructable from
  its transition log after any restore.

## Graceful Degradation

Mapping each dependency to a degradation tier (per the NFR-design degradation
model):

| Dependency | Tier | Degradation behaviour |
|-----------|------|-----------------------|
| Auth session (`unit-platform-auth`) | Critical | No session → 401; command path unavailable by design (fail-closed). |
| Authz PDP (`unit-platform-authz`) | Critical | Cannot decide → `err(forbidden)` (deny), never allow. |
| Durable request store | Critical | Unavailable → command returns a retryable error; no partial writes (`BR-INV-3/4`). |
| HRIS balance (`unit-hris-balance`) | Advisory | Down → submission proceeds; balance shown as unavailable (`BR-VAL-6`). |
| Overlap indicator | Advisory | Down → submission/validation proceed; hint simply absent. |
| Notification / audit-trail consumers | Important | Consume events asynchronously; command commits regardless; missed delivery is a consumer-side retry concern, not a command failure. |

## Failure-Mode Checklist

- **Store write fails mid-command** → nothing is persisted, no event emitted
  (same-logical-commit, `BR-INV-5`); caller receives a retryable error and may
  safely retry (`REL-WF-6`).
- **Two approvers race** → second writer gets `staleState`; exactly one
  transition commits (`REL-WF-5`).
- **Command targets a terminal request** → `err(illegalTransition)`; no state
  change (`BR-WF-6`).
- **Advisory dependency timeout** → ignored on the command path (`REL-WF-2`).
- **Blast radius** → a workflow-service instance failure affects only in-flight
  requests on that instance (stateless; they retry on another instance); it does
  not corrupt persisted state.

## Open Items (for nfr-design)

- Replace the 99.9% placeholder with the concrete availability / response-time
  target from [[requirements]] `req-nfr-availability-tbd`.
- Confirm the durable store's backup cadence and RPO/RTO jointly with
  infrastructure-design and the `audit-trail` retention requirement.
