# Functional Design — memory — `unit-overlap-indicator`

> Running log for this stage. Append under the four standard headings.

## Interpretations
- 2026-09-10T13:42:22Z — Treated the overlap indicator as a strictly READ-ONLY, advisory decision aid for the team lead; grounded in unit-request-workflow business-logic-model ("overlap is a decision aid surfaced to approvers, not submission gates"). It never blocks, mutates, or gates any workflow transition.
- 2026-09-10T13:42:22Z — Interpreted "overlap" as calendar-date-range intersection among team members' requests in the same department, reusing the shipped pure `rangesOverlap(a, b)` primitive from `src/workflow/domain/value-objects.ts` rather than redefining range math (least coupling / do not duplicate).
- 2026-09-10T13:42:22Z — Scoped the overlap comparison set to requests in a non-terminal-or-approved state that consume calendar days (Submitted, Validated, Approved), excluding Rejected/Withdrawn, since only live/approved leave actually competes for coverage.

## Deviations
- 2026-09-10T13:42:22Z — Recorded the four functional-design artifacts to the working tree under `aidlc-docs/construction/unit-overlap-indicator/functional-design/` (matching sibling units on disk) because the `create_artifact` MCP tool is not exposed in this execution surface; content is authored to the documented path so it is durable and traceable.

## Tradeoffs
- 2026-09-10T13:42:22Z — Chose a stateless, query-on-read projection over `VacationRequestRepository.findByDepartmentAndStatus` instead of maintaining an own event-sourced overlap store. Simpler, no duplicate persistence, always consistent with the workflow's source of truth; tradeoff is a per-view query cost, acceptable for the lightweight/should-have scope.
- 2026-09-10T13:42:22Z — Modelled the unit as consuming the workflow read port rather than subscribing to RequestSubmitted events for a materialized cache; event subscription is documented as the alternative if read latency becomes a concern (revisit in nfr-design).

## Open questions
- 2026-09-10T13:42:22Z — Confirm whether inclusive whole-day boundaries (BR-VAL-3 conservative default from the workflow unit) are the intended overlap semantics, or whether half-day/partial-day leave will later require finer granularity.
- 2026-09-10T13:42:22Z — Confirm whether the overlap count should include the request currently under review's own owner (self-overlap excluded here) and whether cross-department overlap is ever relevant (assumed same-department only).
