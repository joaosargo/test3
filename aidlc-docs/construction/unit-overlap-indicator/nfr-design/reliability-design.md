# Reliability Design — `unit-overlap-indicator`

Concrete reliability design for the **Overlap Indicator**. It realises the
reliability posture in [[reliability-requirements]]
(`reliability-requirements-unit-overlap-indicator`) using the fail-open,
Result-typed behaviour from [[business-logic-model]] and the stack fixed by
[[tech-stack-decisions]] (ADR-OVL-01, ADR-OVL-03, ADR-OVL-04). It respects the
latency ceiling in [[performance-requirements]], the stateless scaling model in
[[scalability-requirements]], and the PII-free error contract in
[[security-requirements]].

The governing principle from [[reliability-requirements]]: the indicator is a
**should-have, non-blocking advisory** whose reliability is measured not by its
own uptime but by its **inability to harm the validate/approve path**. It
**fails open**, off the critical path, with a small blast radius. The stated
target is a **99.5% degradation-quality SLO** — i.e. how often the badge is
*correctly present or correctly degraded* — never an availability gate on the
workflow.

## Availability Posture & Degradation SLO

- **REL-OVL-1 — Degradation-quality SLO, not an uptime gate.** Target **99.5%**
  of overlap reads either return a correct `OverlapSummary` or degrade cleanly to
  a typed `err(OverlapError)` that the UI renders as "overlap unavailable". A
  clean fail-open outcome **counts as success** for this SLO — the unit responded
  correctly (mirroring the "expected error = available" convention in
  [[reliability-requirements]]).
- **REL-OVL-2 — Zero coupling to the command path.** The workflow command path
  (submit/validate/approve/reject) never calls this unit, so overlap
  availability can never reduce workflow availability. This is the single most
  important reliability property and is structural, not configured
  ([[business-logic-model]] "failure isolation"; [[reliability-requirements]]).
- **REL-OVL-3 — Advisory, never a gate** (`BR-ADV-2`). No overlap outcome — a
  large count, a timeout, or an error — blocks, delays, or requires
  justification for a lead's decision. The Validate/Reject controls stay fully
  enabled regardless of overlap state.

## Resilience Patterns

Applied proportionately to a fail-open advisory (per the NFR-design resilience
matrix):

- **Timeout (primary control).** A **300 ms** hard timeout wraps the
  `unit-request-workflow` read seam (matching the degradation budget in
  [[reliability-requirements]] and the p99 ceiling in
  [[performance-requirements]]). On expiry the read is abandoned and
  `err(OverlapError.READ_FAILED)` is returned — the lead is never made to wait on
  a slow dependency.
- **Fail-open fallback (`BR-ADV-3`).** Every failure mode — not-found, read
  error, timeout — resolves to a typed `err` that the UI renders as "overlap
  unavailable". The fallback is *absence of the hint*, which is always safe for
  an advisory badge.
- **Retry: none on the read path.** Because the operation is advisory and
  latency-bounded, a failed read is **not** retried inline — retrying would spend
  the lead's latency budget for a hint they can proceed without. The natural
  retry is the next review load (a fresh `computeOverlap` on a fresh TTL window),
  which is idempotent and side-effect-free (`BR-OV-6`).
- **Circuit breaker: optional hardening, deferred.** A per-dependency breaker
  around the workflow seam is documented as optional: it would fail the overlap
  read *fast* (skip the 300 ms wait) if the seam is persistently down. It is
  deliberately **not** in the initial design — the timeout already bounds harm,
  and a breaker adds state/tuning for a component whose failure is harmless. Add
  it only if observability shows sustained seam degradation (see tradeoffs in
  `memory.md`).
- **No bulkhead of its own.** The unit holds no thread pool or connection pool
  to isolate; it inherits the app tier's isolation and consumes the workflow
  unit's pooled read seam.

## Fault Tolerance & No-State Obligations

- **REL-OVL-4 — No owned state to lose** (INV-OV-1, ADR-OVL-04). The unit owns
  no datastore, no queue, and no persistent cache; every `OverlapSummary` is
  recomputed from the workflow's authoritative store. There is no backup, no
  replication, and no recovery procedure to design — a process restart loses only
  the transient short-TTL cache, which repopulates lazily on the next read.
- **REL-OVL-5 — Deterministic, idempotent recompute** (`BR-OV-6`). For a fixed
  underlying workflow state, `computeOverlap` always yields the same summary and
  mutates nothing, so restarts, retries, and instance loss are all safe by
  construction — there is nothing to reconcile.
- **REL-OVL-6 — Expected failures are values, not exceptions** (ADR-OVL-03;
  [[business-logic-model]]). Not-found and read-seam errors return
  `Result.err(OverlapError)` with a PII-free code
  ([[security-requirements]] `BR-PII-3`); throwing is reserved for
  misconfiguration, so a transient dependency blip never crashes the app-tier
  process.
- **REL-OVL-7 — No effect on audit or notifications** (`BR-ADV-4`). The unit
  emits no domain events, so an overlap failure produces no missed audit facts
  and no dropped notifications — it is invisible to the immutable trail. There is
  no delivery-guarantee obligation to design.

## Failure-Mode Checklist

| Failure | Behaviour | Impact |
|---------|-----------|--------|
| Reviewed request not found | `err(NOT_FOUND)` → "overlap unavailable" | None on decision (`BR-ADV-3`). |
| Workflow read seam errors | `err(READ_FAILED)` → "overlap unavailable" | None on decision; not retried inline. |
| Read seam slow (> 300 ms) | Timeout → `err(READ_FAILED)` fail-open | Lead not delayed; badge absent. |
| Stale cache within TTL | Slightly stale count (≤ ~10 s) | Acceptable for advisory; never authoritative (`BR-OV-5`). |
| Instance restart | Cold cache; lazy repopulate | Transient extra reads; no data loss (REL-OVL-4). |
| Unit fully down | All badges show "unavailable" | Workflow decisions unaffected (REL-OVL-2). |

**Blast radius:** a single overlap read failure affects one badge on one review
card; a total outage of the unit degrades every badge to "unavailable" while the
entire validate/approve path keeps working. No failure of this unit can corrupt
state, block a decision, or lose an audit fact.

## Verification

- Unit tests (vitest, ADR-OVL-06, ≥ 80% coverage) assert fail-open on injected
  read errors and timeouts: a failing/slow `VacationRequestRepository` stub must
  yield `err(OverlapError)`, never a throw or a hang past the timeout.
- A test asserts `computeOverlap` never invokes a mutating workflow method
  (structural read-only, INV-OV-2).
- A determinism test asserts identical summaries for identical underlying state
  across repeated calls (`BR-OV-6`, REL-OVL-5).
