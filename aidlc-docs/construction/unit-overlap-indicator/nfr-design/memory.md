# NFR Design — memory — `unit-overlap-indicator`

> Running log for this stage. Append under the four standard headings.

## Interpretations
- 2026-09-10T13:58:09Z — Proceeded in full mode without raising clarifying questions: the functional-design open questions (inclusive whole-day boundaries, same-department scope, self-exclusion) are already resolved by shipped business rules `BR-OV-1..4` / `BR-SCOPE-2`, and the unit is a should-have, read-only, fail-open advisory with modest, well-bounded NFRs. No blocking ambiguity remained to justify a gate.
- 2026-09-10T13:58:09Z — Anchored every NFR-design decision to the four `nfr-requirements` inputs for this unit (`performance-requirements`, `reliability-requirements`, `scalability-requirements`, `security-requirements`), the `tech-stack-decisions` ADRs (ADR-OVL-01..06), and the functional-design `business-logic-model` / `business-rules` / `domain-entities` for the overlap read.
- 2026-09-10T13:58:09Z — Treated fail-open + advisory-only (`BR-ADV-1..4`) as the dominant NFR force: reliability design centres on NOT propagating failure into the workflow command path, and the security design leans on inherited auth/authz rather than a new trust boundary.

## Deviations
- 2026-09-10T13:58:09Z — Recorded the five nfr-design artifacts to the working tree under `aidlc-docs/construction/unit-overlap-indicator/nfr-design/` (matching sibling units and this unit's own functional-design on disk) because the `create_artifact` MCP tool is not exposed in this execution surface; content is authored to the documented path so it is durable, sensor-visible, and traceable.

## Tradeoffs
- 2026-09-10T13:58:09Z — Chose an in-process short-TTL request-coalescing cache (per ADR-OVL-04) over an event-materialized overlap projection. Simpler, no owned datastore, always reconstructable from the workflow source of truth; tradeoff is a per-view query fan-out across three statuses, acceptable at the modest should-have load and mitigated by the short-TTL cache and a hard read timeout.
- 2026-09-10T13:58:09Z — Chose a per-read hard timeout + fail-open over a full circuit breaker as the primary resilience pattern; documented the breaker as an optional hardening if the workflow read seam ever degrades under load. A breaker adds state and tuning for a component whose failure is already harmless (advisory), so the timeout carries most of the value at far lower complexity.

## Open questions
- 2026-09-10T13:58:09Z — Confirm the concrete overlap read-timeout figure (300ms proposed, matching the reliability-requirements degradation budget) against the eventual workflow read-seam p99 once unit-request-workflow's store is wired in infrastructure-design.
