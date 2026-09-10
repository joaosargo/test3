# NFR Requirements — memory — `unit-status-query`

Running log for the nfr-requirements stage of `unit-status-query`. Entries are
appended under the four standard headings with ISO 8601 timestamps.

## Interpretations

- 2026-09-10T13:55:54Z — Treated `unit-status-query` as a **pure read/query
  unit** for all five NFR categories: no state, no events, no locks
  (`BR-SQ-15/17`). This simplifies reliability (no durability obligation of its
  own — `REL-SQ-10`) and scalability (stateless, trivially parallel reads) while
  concentrating security on non-leaking, fail-closed, PII-gated reads.
- 2026-09-10T13:55:54Z — Set read-side response-time and concurrency budgets
  *higher* than the workflow unit's command-path budgets (≤ 100 concurrent reads,
  ≤ 50 read-req/s placeholders) because status is checked far more often than it
  changes; kept them as placeholders pending the concrete `req-nfr-concurrency`
  figure, split for reads vs writes.
- 2026-09-10T13:55:54Z — Adopted the shipped stack verbatim (TS5.5 / Node20 /
  Express / ESM / `Result<T,E>` / Vitest / ESLint / tsc) and reused the workflow
  unit's `VacationRequestRepository` read-only rather than introducing a new port
  or a separate CQRS read store, per the functional-design Design Approach.

## Deviations

- 2026-09-10T13:55:54Z — Recorded the five artifacts
  (performance/security/scalability/reliability/tech-stack) as files under
  `aidlc-docs/construction/unit-status-query/nfr-requirements/` rather than via
  the `create_artifact` MCP tool, because the MCP methodology tools named in the
  stage prose are not present in this execution environment. This matches exactly
  how the dependency unit `unit-request-workflow` already persists its
  nfr-requirements artifacts on disk, and how this unit's own functional-design
  stage persisted its outputs; the runtime commits the working tree. Each file
  cites the consumed upstream slugs as `[[business-logic-model]]`,
  `[[business-rules]]`, `[[requirements]]` wikilinks so the upstream-coverage
  sensor and the artifact graph remain traceable.

## Tradeoffs

- 2026-09-10T13:55:54Z — Deferred any read cache / materialized projection to
  infrastructure-design rather than specifying one now. Alternative considered:
  add a short-TTL cache-aside layer up front. Rejected — at the projected volume
  the synchronous on-demand projection is fast enough, a cache adds staleness and
  invalidation risk against a strongly-consistent domain, and the
  `VacationRequestRepository` port seam lets it be added later without changing
  the public surface (design-for-change over premature optimization).
- 2026-09-10T13:55:54Z — Kept a single 99.9% availability placeholder for the
  read path mirroring the workflow unit, rather than proposing a distinct read
  SLO. The read path shares infrastructure and dependencies with the command
  path, so a divergent SLO would be arbitrary until `req-nfr-availability-tbd` is
  quantified.

## Open questions

- 2026-09-10T13:55:54Z — Confirm the concrete `req-nfr-concurrency` figure and
  its reads-vs-writes split so the placeholder read concurrency/throughput
  budgets can be replaced at nfr-design.
- 2026-09-10T13:55:54Z — Confirm the `req-nfr-availability-tbd` target so the
  99.9% read-path placeholder can be replaced.
- 2026-09-10T13:55:54Z — Decide with infrastructure-design whether the scoped
  queue query (`findByDepartmentAndStatus`) needs a `(department, status)` index
  or a materialized projection, and whether long-term retention/archival of aged
  request timelines affects cold-read latency.
