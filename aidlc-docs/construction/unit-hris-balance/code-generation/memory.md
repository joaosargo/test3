<!-- code-generation stage memory — unit-hris-balance -->

## Interpretations
- 2026-09-10T12:46:28Z — grounded the implementation on the compiled graph context (business-logic-model, business-rules, domain-entities, performance-design, security-design, deployment-architecture for unit-hris-balance) since the detailed artifact bodies were only available as gists + section headings; the getBalance Result-typed read-through contract, non-blocking degradation, short-TTL cache-aside, 800ms timeout, and PII rules are all derived from those gists.
- 2026-09-10T12:46:28Z — followed the existing unit-platform-auth hexagonal layout exactly (domain / ports / adapters / services / config) with .js import specifiers, Result<T,E> value-level failures, and injected clock/timeouts, matching the shipped conventions rather than introducing new ones.
- 2026-09-10T12:46:28Z — implemented the HRIS system-of-record as an injected HrisClientPort (anti-corruption boundary); the in-memory/stub adapter is the walking-skeleton wiring, production swaps a real HRIS SDK behind the same port. Balance retrieval is strictly read-only (no write path exists on any branch) per req-constraint-hris-system-of-record.

## Deviations
- 2026-09-10T12:46:28Z — recorded the code-generation-plan and code-summary as markdown under aidlc-docs/construction/unit-hris-balance/code-generation/ (mirroring unit-platform-auth) because the methodology-graph MCP artifact tools (create_artifact) were not present in the available toolset for this run; the source code itself is written to the working tree as required.

## Tradeoffs
- 2026-09-10T12:46:28Z — chose cache-aside with a short TTL and a single-flight-free simple map cache for the walking skeleton over a full dedup/coalescing layer; the display-only, non-blocking nature (a miss degrades, never blocks) makes the simpler cache acceptable and keeps it unit-testable.
- 2026-09-10T12:46:28Z — modelled degradation as a typed BalanceOutcome union (available | unavailable) returned inside Result.ok rather than as Result.err, because unavailability is an expected advisory display state, not a caller error; hard faults (bad input) remain Result.err.

## Open questions
- 2026-09-10T12:46:28Z — confirm the concrete HRIS product/SDK and its auth model (open procurement decision) before infrastructure hardening; current code targets a pluggable HrisClientPort with a stub adapter.
- 2026-09-10T12:46:28Z — confirm the exact leave-balance fields the HRIS exposes (accrued/used/remaining/asOf) and their units (days vs hours); current read-model assumes days with an asOf freshness timestamp.
