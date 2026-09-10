# Security Requirements — `unit-status-query`

Security NFRs for the **Status Tracking & Query** unit — the read side of the
vacation-request modular monolith. The unit establishes **no** identity and owns
**no** authorization policy: authentication is delegated to `unit-platform-auth`
and every authorization decision to the `unit-platform-authz` PDP. Its security
posture therefore centres on **consuming those upstream guarantees fail-closed
on every read**, on **not leaking data or existence across role/scope
boundaries**, and on **PII-gating the data it projects**. Requirements trace to
the fail-closed read-authorization ordering and PII rules in [[business-rules]]
(`BR-SQ-1`, `BR-SQ-4`, `BR-SQ-6`, `BR-SQ-16`), the guarded-read design and
projection shapes in [[business-logic-model]] (Query Flows, Data Flow), and
[[requirements]] `req-nfr-security-pii`, `req-rbac-three-roles-hr-scoping`,
`req-status-tracking`.

## Authentication & Authorization

- **SEC-SQ-1 — No in-house auth, no re-derived roles or scope.** The unit never
  authenticates a caller and never derives roles or department scope itself.
  Guarded routes compose `requireSession(...)` (auth) → `requirePermission(authz,
  '<view-permission>')` (authz) → status-query handler, the same pipeline the
  `unit-request-workflow` router uses ([[business-logic-model]] Data Flow;
  [[business-rules]] `BR-SQ-1/3`). Consuming the shipped
  `AuthenticatedPrincipal` and `AuthzService.decide` surface is mandatory;
  re-implementing RBAC is forbidden.
- **SEC-SQ-2 — Every read is authorized before any data touch.** No projection
  is computed and no repository row is returned before `AuthzService.decide`
  returns a permit; a deny short-circuits with `err(forbidden)` and reads no data
  ([[business-rules]] `BR-SQ-1`). There is no permissive default and no "public"
  read on any path.
- **SEC-SQ-3 — Least-privilege view permission by query intent.** The permission
  passed to the PDP is the narrowest that could authorize the read:
  `request:view-own` (employee own-list), `request:view-team` (team-lead queue),
  `request:view-department` (HR department view) — exactly the shipped closed
  permission set ([[business-rules]] `BR-SQ-2`). The unit invents no new
  permission.
- **SEC-SQ-4 — Scope enforced by the PDP, confirmed here.** HR per-department
  ABAC and team-lead own-team scoping are decided entirely by
  `AuthzService.decide` using the `{ department }` resource descriptor
  ([[business-rules]] `BR-SQ-3`; `req-rbac-three-roles-hr-scoping`). The unit
  applies only a narrow defence-in-depth row filter from the returned
  `grant.departmentScope` (`BR-SQ-5`) that may only *narrow or confirm*, never
  *widen*, access.
- **SEC-SQ-5 — Read-only, no privilege to change anything.** The unit exposes no
  command; it cannot transition, edit, or re-open a request ([[business-rules]]
  `BR-SQ-15`). There is therefore no override or escalation surface on the read
  side — the no-override guarantees live on the command path
  (`unit-request-workflow`).

## Data Protection & PII

- **SEC-SQ-6 — Non-leaking existence semantics.** A `getRequestTimeline` for an
  id the caller may not see never confirms the id exists to an out-of-scope
  caller: the combined `notFound` / `forbidden` posture is identical to the
  `unit-request-workflow` "command on unknown request id" edge case
  ([[business-rules]] `BR-SQ-4`; [[business-logic-model]] Query C "Order matters
  and is fail-closed"). Read and command sides leak nothing differently.
- **SEC-SQ-7 — Out-of-scope rows are omitted, never per-row denied.** A scoped
  list simply does not contain rows outside the caller's scope; the query returns
  no per-row `forbidden` that would reveal a row's existence ([[business-rules]]
  `BR-SQ-7`). Only a whole-query authorization failure produces `err(forbidden)`.
- **SEC-SQ-8 — Free-text reason is role-gated at projection time.** A
  `Transition`'s free-text `reason` (which may carry incidental PII) is included
  in a `TimelineEntry` only when the caller is entitled to it, and is **omitted**
  (not returned as a placeholder that leaks its existence) otherwise
  ([[business-rules]] `BR-SQ-6`; `req-nfr-security-pii`). Machine-readable
  status/stage codes are always PII-free and always returned.
- **SEC-SQ-9 — PII-lean projections by construction.** `RequestSummaryView` and
  `RequestTimelineView` carry opaque ids and department codes only; they never
  carry names, emails, or free-text beyond the role-gated `reason`
  ([[business-logic-model]] Read Model; [[business-rules]] `BR-SQ-9`,
  `req-nfr-security-pii`).
- **SEC-SQ-10 — PII redacted at every log boundary.** Principal ids, department
  codes, and free-text reasons are redacted at every log boundary, and all
  `StatusQueryError` messages are static PII-free constants ([[business-rules]]
  `BR-SQ-16`; `req-nfr-security-pii`), mirroring the `BR-PII-*` posture of the
  upstream units.
- **SEC-SQ-11 — Encryption in transit and at rest (inherited).** The unit reads
  employee PII (dates, and role-gated reason) over the shared store; all HTTP is
  TLS-encrypted in transit and the durable append-only store — owned by
  `unit-request-workflow` / infrastructure-design — provides at-rest encryption
  (`req-nfr-security-pii`). This unit adds no new persistence and so introduces
  no new at-rest surface.

## Integrity & Consistency

- **SEC-SQ-12 — Reads never mutate; no tamper surface.** No query writes,
  appends a transition, or emits an event ([[business-rules]] `BR-SQ-15`), so the
  read side cannot corrupt the append-only history that the immutable
  `audit-trail` depends on. A status read is not itself an audited fact
  (`audit-trail` records transitions, not views).
- **SEC-SQ-13 — Status is derived, never independently stored.** The current
  `status` in any projection is the `to` of the latest `Transition`
  ([[business-rules]] `BR-SQ-8`, reading the workflow unit's `BR-INV-4` through
  the port), so a view can never silently disagree with the command side's truth
  — there is no divergent read column to tamper with or fall stale.

## Threat Considerations

- **Cross-employee read attempt** → impossible: `view-own` grants only self
  scope (`SEC-SQ-3`) and the row filter re-asserts owner identity
  (`SEC-SQ-4`, [[business-rules]] `BR-SQ-5`).
- **Cross-department read attempt (HR)** → denied by the PDP's per-department
  ABAC before any row is projected (`SEC-SQ-2/4`).
- **Existence-probing an unknown or out-of-scope id** → non-leaking
  `notFound`/`forbidden` (`SEC-SQ-6`); the response does not confirm existence.
- **Reason-text harvesting** → blocked by role-gated omission (`SEC-SQ-8`); an
  unentitled caller cannot even tell a reason was recorded.
- **Replay / forged session** → out of scope for this unit; owned by
  `unit-platform-auth` session validation, consumed here via `requireSession`.
- **Authz PDP unavailable** → the read **denies** (`err(forbidden)`), never
  falls open — see [[reliability-requirements]] fail-closed posture.
