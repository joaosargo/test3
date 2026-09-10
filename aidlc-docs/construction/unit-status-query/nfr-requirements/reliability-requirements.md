# Reliability Requirements — `unit-status-query`

Reliability NFRs for the **Status Tracking & Query** unit — availability, fault
tolerance, consistency, degradation, and recovery for the read/query side of the
vacation-request modular monolith. Because this unit owns no state, emits no
events, and takes no locks ([[business-rules]] `BR-SQ-15`, `BR-SQ-17`), its
reliability concerns are simpler than the command path's: it must **fail closed
on its dependencies**, **never return data the caller is not entitled to even
under failure**, and **always reflect committed truth**. Targets derive from the
guarded-read design in [[business-logic-model]] (Query Flows, Data Flow), the
fail-closed and derived-status rules in [[business-rules]] (`BR-SQ-1`, `BR-SQ-4`,
`BR-SQ-8`, `BR-SQ-17`), and the availability and PII NFRs in [[requirements]]
(`req-nfr-availability-tbd`, `req-nfr-security-pii`, `req-status-tracking`).

Reliability for a read surface means **correctness of what is shown and safe
behaviour when a dependency is degraded** — a status view that shows another
role's data, or that lingers stale after a transition, is a correctness failure,
not merely an availability one.

## Availability Targets (SLO)

- **REL-SQ-1 — Read-path availability.** Target **99.9%** monthly availability
  for the status-read path (own list / scoped queue / timeline), measured as
  `successful_or_expected-error_responses / total_requests` — a well-formed
  `err(forbidden|notFound|invalidInput)` counts as available because the service
  responded correctly ([[business-rules]] `BR-SQ-1/4/12`). This is a placeholder
  pending the concrete figure tracked as `req-nfr-availability-tbd` in
  [[requirements]] (see Open Items); 99.9% ≈ 43 min/month error budget.
- **REL-SQ-2 — Read availability rides on shared infrastructure.** Because reads
  are stateless and pure, availability is bounded by the auth/authz services, the
  shared append-only store's read availability, and the process itself — this
  unit adds no new stateful dependency of its own ([[business-logic-model]] Data
  Flow).

## Fault Tolerance & Fail-Closed Behaviour

- **REL-SQ-3 — Fail-closed on the authz dependency.** If the authz PDP cannot
  render a decision, the read **denies** (`err(forbidden)`) rather than returning
  data ([[business-rules]] `BR-SQ-1/3`), consistent with the authz unit's
  `DIRECTORY_UNAVAILABLE → deny` posture and the workflow unit's `REL-WF-3`.
  Reliability here means failing safe — never leaking data because a check was
  unavailable.
- **REL-SQ-4 — Fail-closed on the session dependency.** No valid session → `401`
  via `requireSession`; the read path is unavailable to an unauthenticated caller
  by design ([[business-logic-model]] Data Flow). This is a deliberate
  fail-closed, not an outage.
- **REL-SQ-5 — Store read failure surfaces as a retryable error.** If the shared
  `VacationRequestRepository` read fails or times out, the query returns a
  retryable `Result.err` and no partial or fabricated data ([[business-rules]]
  `BR-SQ-1`); it never falls back to a permissive or cached-but-unauthorized
  view. Retries are safe because reads are idempotent and side-effect-free
  (`BR-SQ-15`).
- **REL-SQ-6 — Expected failures are values, not exceptions.** Authorization
  denials, unknown ids, and invalid query input return `Result.err` with a
  PII-free code ([[business-logic-model]] Error handling; [[business-rules]]
  `BR-SQ-1/4/12/16`). Throwing is reserved for programmer error /
  misconfiguration, so transient business failures never crash the process —
  the same convention shipped across the auth, authz, and workflow units.

## Consistency & Correctness

- **REL-SQ-7 — Reads reflect committed truth (no read-your-writes gap).** The
  read model is a synchronous on-demand projection over the same append-only
  store the command side writes, not a separate eventually-consistent copy
  ([[business-logic-model]] Design Approach), so a projection reflects every
  transition committed at read time ([[business-rules]] `BR-SQ-17`). There is no
  replication lag for the vacation domain's scale.
- **REL-SQ-8 — Status can never disagree with history.** Current `status` is the
  `to` of the latest `Transition` ([[business-rules]] `BR-SQ-8`, the workflow
  unit's `BR-INV-4` read through the port); state and history are the same data
  read two ways, so a view is structurally incapable of drifting from the command
  side's truth.
- **REL-SQ-9 — Non-leaking failure semantics under all outcomes.** Whether a
  request is missing, terminal, or out of scope, the `notFound`/`forbidden`
  posture never confirms existence to an unauthorized caller ([[business-rules]]
  `BR-SQ-4`; [[business-logic-model]] Query C). Correct behaviour under the
  "unauthorized asks for a real id" failure mode is a reliability requirement,
  not only a security one.

## Graceful Degradation

Mapping each dependency to a degradation tier (per the NFR-design degradation
model):

| Dependency | Tier | Degradation behaviour |
|-----------|------|-----------------------|
| Auth session (`unit-platform-auth`) | Critical | No session → 401; read path unavailable by design (fail-closed, `REL-SQ-4`). |
| Authz PDP (`unit-platform-authz`) | Critical | Cannot decide → `err(forbidden)` (deny), never return data (`REL-SQ-3`). |
| Shared request store (`unit-request-workflow`) | Critical | Read unavailable → retryable error, no stale/fabricated view (`REL-SQ-5`). |
| Optional read cache / materialized projection (future) | Advisory | Miss or down → fall through to the on-demand projection over the store; correctness unaffected. |

There is no advisory data on the read path whose absence must be tolerated — the
status surface either authoritatively shows in-scope committed data or returns a
typed error. (Contrast the command path, where HRIS balance and overlap are
advisory.)

## Failure-Mode Checklist

- **Authz PDP unavailable** → `err(forbidden)`; no data returned (`REL-SQ-3`).
- **Store read times out** → retryable `err`; caller may safely retry
  (`REL-SQ-5`, reads are idempotent).
- **Unauthorized caller requests a real id** → non-leaking
  `notFound`/`forbidden` (`REL-SQ-9`, [[business-rules]] `BR-SQ-4`).
- **Concurrent transition during a read** → read reflects whatever is committed
  at read time; no lock, no torn read (`REL-SQ-7/8`, [[business-rules]]
  `BR-SQ-17`).
- **Invalid query input** → `err(invalidInput)` with the offending field, no
  read attempted ([[business-rules]] `BR-SQ-12/13/14`).
- **Blast radius** → a status-query instance failure affects only in-flight reads
  on that instance (stateless; clients retry on another instance); it cannot
  corrupt persisted state because the unit performs no writes (`BR-SQ-15`).

## Durability, Backup & Recovery

- **REL-SQ-10 — No durability obligation of its own.** The unit persists nothing
  ([[business-rules]] `BR-SQ-15`); durability, backup, and point-in-time recovery
  of the underlying append-only history are owned by `unit-request-workflow`
  (`REL-WF-8/9`) and the `audit-trail` retention requirement
  (`req-nfr-audit-retention`). After any store restore, this unit's projections
  are immediately correct because they are derived on demand from the restored
  history (`REL-SQ-7/8`).

## Open Items (for nfr-design)

- Replace the 99.9% placeholder with the concrete availability / response-time
  target from [[requirements]] `req-nfr-availability-tbd`.
- Confirm, with infrastructure-design, the read availability contributed by the
  shared store and whether read replicas are warranted at the confirmed volume.
