# Functional Design — memory — `unit-status-query`

Running log for the functional-design stage of `unit-status-query`. Entries are
appended under the four standard headings with ISO 8601 timestamps.

## Interpretations

- 2026-09-10T13:42:35Z — Modelled the unit as a CQRS **read model** with a
  **synchronous on-demand projection** over the shipped append-only store (via
  `VacationRequestRepository`), not a separate eventually-consistent read store;
  the vacation domain is small/strongly-consistent (one lead, then one HR
  approver per request) so a denormalized copy would add replication-lag and
  rebuild cost for no benefit. Left the port seam so a materialized projection
  can be added later without changing the public query surface.
- 2026-09-10T13:42:35Z — Chose the three view permissions (`request:view-own`,
  `request:view-team`, `request:view-department`) straight from the shipped
  closed permission set in `src/authz/domain/roles.ts`; invented no new
  permission. Query intent selects the least-privilege permission.
- 2026-09-10T13:42:35Z — Treated `unit-status-query` as UI-bearing and wrote the
  conditional `frontend-components.md`: it owns the **read-only status view**
  (list rows, badge, timeline) while `unit-request-workflow` keeps the mutating
  action screens. Split chosen to avoid duplicating the `<MyRequestsList>` /
  `<RequestStatusBadge>` shells the workflow unit already sketched.

## Deviations

- 2026-09-10T13:42:35Z — Recorded the four artifacts as files under
  `aidlc-docs/construction/unit-status-query/functional-design/` rather than via
  the `create_artifact` MCP tool, because the MCP methodology tools named in the
  stage prose are not present in this execution environment. This matches exactly
  how the dependency units (`unit-request-workflow`, `unit-platform-authz`)
  already persist their functional-design artifacts on disk, and the runtime
  commits the working tree. If the graph expects `create_artifact`, these files
  are the durable fallback and are graph-traceable via the cited `[[slug]]`
  wikilinks.
- 2026-09-10T13:42:35Z — Defined **no new persistence port**; reused the
  workflow unit's `VacationRequestRepository` (`findById` / `findByOwner` /
  `findByDepartmentAndStatus`) rather than a parallel read port. Slight deviation
  from a textbook CQRS "separate read port", justified by keeping a single
  anti-corruption seam over the store and guaranteeing read/command see the same
  rows.

## Tradeoffs

- 2026-09-10T13:42:35Z — Scope enforcement kept **entirely in the PDP**
  (`AuthzService.decide`), with only a narrow defence-in-depth row filter here
  (BR-SQ-5). Alternative considered: re-derive team/department membership in the
  read unit for speed. Rejected — it would duplicate `BR-AUTHZ-5/6` and risk the
  two definitions drifting; least-coupling wins over a micro-optimization on an
  already in-process O(1) decision.
- 2026-09-10T13:42:35Z — Role-gated `reason` by **omission** rather than a
  redacted placeholder (BR-SQ-6). Omission avoids leaking that a note existed;
  the tradeoff is the client cannot distinguish "no reason given" from "reason
  hidden", which is acceptable and the more privacy-preserving default.
- 2026-09-10T13:42:35Z — Two default orderings (lead queue oldest-first;
  employee/HR lists newest-changed-first, BR-SQ-10). Adds a small rule surface vs
  a single global order, but matches how each audience actually uses the list (a
  work queue vs a status check).

## Open questions

- 2026-09-10T13:42:35Z — Confirm the concrete read endpoint paths
  (`/status/requests`, `/status/departments/:department/requests`,
  `/status/requests/:id/timeline`) with the workflow unit's router owner so the
  status routes don't collide with `GET /requests/:id` already defined there; the
  chosen `/status/*` prefix is a conservative default.
- 2026-09-10T13:42:35Z — Confirm whether a team lead's queue should scope by an
  explicit `department` argument (as modelled) or by an implicit "own team"
  derived solely from the grant; current design passes `department` and lets the
  PDP arbitrate, but the lead own-team predicate (`BR-AUTHZ-6`) may not need the
  argument at all.
- 2026-09-10T13:42:35Z — Confirm reason-visibility policy for a team lead viewing
  an HR-stage rejection reason (and vice versa): BR-SQ-6 currently grants
  in-scope viewers the reason; product may want stage-author-only visibility.
