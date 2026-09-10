# Performance Requirements — `unit-request-workflow`

Performance NFRs for the **Vacation Request Workflow** unit — the synchronous
command-path core that drives the `VacationRequest` aggregate through the
two-stage approval workflow. Targets are derived from the workflow shape in
[[business-logic-model]] (Workflows A/B/C), the fail-closed guard ordering in
[[business-rules]] (`BR-WF-7`, `BR-INV-3`), and the concurrency / response-time
NFRs enumerated in [[requirements]] (`req-nfr-concurrency`,
`req-nfr-availability-tbd`).

This is an internal, human-in-the-loop line-of-business workflow (one employee
submits; one team lead validates; one HR approver approves). Load is modest and
bursty around start-of-day and end-of-quarter, not high-throughput machine
traffic. The performance envelope is sized accordingly — correctness and
fail-closed behaviour take precedence over raw throughput, consistent with the
posture already shipped in `unit-platform-auth` and `unit-platform-authz`.

## Response-Time Targets

Latency budgets are for the **server-side** command/query handling only
(request received at the Express handler → response written), excluding client
network and browser render. The path is: `requireSession` (auth) →
`requirePermission` (authz, in-process O(1) Set check per the authz
`code-summary`) → workflow service (load aggregate → guard → transition →
persist → emit event).

| Operation | Target (p95) | Target (p99) | Rationale |
|-----------|--------------|--------------|-----------|
| `submitRequest` (Workflow A) | ≤ 200 ms | ≤ 400 ms | Validate input + single append-only create + one event emit. |
| `leadDecision` validate/reject (Workflow B) | ≤ 200 ms | ≤ 400 ms | One load + guard + append + persist + event. |
| `hrDecision` approve/reject (Workflow C) | ≤ 200 ms | ≤ 400 ms | Same shape as Workflow B. |
| Command-path authorization check | ≤ 5 ms | ≤ 10 ms | In-process grant-table Set membership (no network) per authz `code-summary`. |
| Aggregate load by id (`findById`) | ≤ 50 ms | ≤ 100 ms | Single-key read from the append-only store. |

- The advisory HRIS balance and the overlap indicator are **not** on the
  submission critical path ([[business-logic-model]] "Balance … advisory only";
  [[business-rules]] `BR-VAL-6`). They are fetched by their own units and must
  never block or extend the `submitRequest` budget above; if they are slow or
  unavailable the command still completes within budget.

## Throughput & Concurrency

- **Concurrency target** (`req-nfr-concurrency`): the unit must sustain the
  enterprise's expected concurrent approval activity. Baseline sizing assumption
  (to confirm at NFR-design): peak **≤ 50 concurrent in-flight commands** and
  **≤ 25 requests/second** aggregate on the workflow path, with headroom to 2×.
  These are placeholders pending the concrete concurrency figure in
  [[requirements]] `req-nfr-concurrency` (see Open Items).
- **Optimistic concurrency, not locking** ([[business-rules]] `BR-INV-3`): two
  approvers acting on the same request resolve by version check — the losing
  writer gets `err(staleState)` and re-reads. This keeps no locks on the hot
  path, so per-request latency does not degrade under contention; contention is
  inherently low (one lead, then one HR approver per request).
- **Stateless service instances**: the workflow service holds no per-request
  state between calls (all state is in the aggregate store), so instances scale
  horizontally behind a load balancer — see [[scalability-requirements]].

## Resource & Efficiency Constraints

- **Bounded work per command**: each command performs at most one aggregate
  load, one append-only persist, and one event emit (`BR-INV-4`, `BR-INV-5`).
  No N+1 reads, no cross-aggregate transactions ([[business-logic-model]]
  keeps transactions within the single `VacationRequest` aggregate).
- **Append-only history growth**: `history` grows by exactly one `Transition`
  per accepted transition and is bounded (a request reaches a terminal state in
  ≤ 3 transitions), so per-aggregate size is small and predictable.
- **Repository port isolates the store**: the `VacationRequestRepository` seam
  ([[domain-entities]]) lets the in-memory dev/test adapter be swapped for a
  durable append-only store without changing the service, so production
  persistence performance is tunable behind the port.
- **Event emission is fire-and-forward**: side-effecting consumers
  (`audit-trail`, `notification`, `overlap-indicator`) run via choreography and
  must not be awaited on the command path beyond the same-logical-commit event
  publish, so downstream slowness does not inflate command latency.

## Measurement & Benchmarks

- Instrument each command with a server-side duration metric (histogram) tagged
  by operation and outcome (`ok` / error code) so p95/p99 can be tracked against
  the table above (detailed observability design is owned by
  [[reliability-requirements]] and nfr-design).
- The existing `vitest` suite is the functional-correctness gate; a lightweight
  load smoke (drive N concurrent `leadDecision` calls against one request,
  assert exactly one succeeds and the rest return `staleState`) validates the
  optimistic-concurrency behaviour without a full load rig.

## Open Items (for NFR-design)

- Replace the placeholder concurrency/throughput figures above with the concrete
  target from [[requirements]] `req-nfr-concurrency` once quantified.
- Confirm the p95/p99 response-time budget against the availability/response-time
  target tracked as `req-nfr-availability-tbd` (currently a dependency/TBD in
  [[requirements]]).
