# Tech-Stack Decisions — `unit-status-query`

Technology selections and rationale for the **Status Tracking & Query** unit —
the read side of the vacation-request modular monolith. The dominant constraint
is **consistency with the already-shipped monolith**: `unit-platform-auth`,
`unit-platform-authz`, `unit-hris-balance`, and `unit-request-workflow` are in
the tree with a fixed stack and hexagonal layout, and this unit consumes their
public surfaces **read-only** ([[business-logic-model]] Data Flow;
[[business-rules]] `BR-SQ-1/3/8`). Decisions therefore mostly **adopt** the
established stack rather than introduce new technology — the least-coupling,
design-for-change posture in the architecture guidance and the team `## Way of
Working` / `## Code Style` rules. Choices trace to the query shapes in
[[business-logic-model]], the read rules and invariants in [[business-rules]],
and the constraints in [[requirements]] (`req-nfr-security-pii`,
`req-status-tracking`, `req-rbac-three-roles-hr-scoping`).

## Language, Runtime & Framework

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Language | **TypeScript 5.5** (strict) | Matches the shipped units; static types make the projection shapes (`RequestSummaryView`, `RequestTimelineView`) and `Result<T,E>` errors compile-checked. |
| Runtime | **Node.js ≥ 20** | Fixed by `package.json` `engines`; shared across all units. |
| HTTP framework | **Express 4** | Already the app's router; the unit composes `requireSession → requirePermission → handler` on Express, per [[business-logic-model]] Data Flow and the authz `code-summary`. |
| Module system | **ESM** with `.js` import specifiers | Mirrors the shipped `.js` ESM import convention (authz / workflow `code-summary`). |
| Error model | **`Result<T, StatusQueryError>`** (no throwing for expected failures) | Reuses `src/domain/result.ts`; mirrors `SsoError` / `AuthzError` / `HrisError` / `WorkflowError` taxonomy ([[business-logic-model]] Error handling; [[business-rules]] `BR-SQ-16`). |

**Decision — adopt the shipped stack, add no new runtime/framework
dependency.** A different language or web framework for one read unit of a
modular monolith would fragment the build, duplicate the hexagonal seams, and
break the shared `requireSession`/`requirePermission` composition — a net
increase in coupling for no benefit. Rejected alternatives: a separate read
service in another language (premature microservice split — the units-generation
topology keeps this an in-process unit); a GraphQL layer for the three read
shapes (adds a schema/resolver runtime the three fixed queries do not need; plain
Express handlers returning projections are simpler and match the shipped units).

## Read Model & Persistence Access

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Architecture style | **Hexagonal (ports & adapters)** within the modular monolith | Same seam as shipped units; the projection logic is unit-testable without a store ([[business-logic-model]] Design Approach). |
| Read model | **Synchronous on-demand projection**, not a separate eventually-consistent read store | The vacation domain is small and strongly consistent (one lead, then one HR approver per request); a denormalized copy would add replication-lag and rebuild cost for no benefit ([[business-logic-model]] Design Approach; [[business-rules]] `BR-SQ-17`). |
| Persistence access | **Reuse `VacationRequestRepository`** (`findById` / `findByOwner` / `findByDepartmentAndStatus`) read-only | No parallel read port; a single anti-corruption seam over the store guarantees read and command see the same rows ([[business-logic-model]] Data Flow; functional-design memory Deviation). |
| Status derivation | **Derived** — the `to` of the latest `Transition`, never a stored column | Reads the workflow unit's `BR-INV-4` through the port ([[business-rules]] `BR-SQ-8`); view can never disagree with command truth. |
| Dev/test adapter | **In-memory** implementation | Mirrors the shipped `InMemorySessionStore` / `InMemoryRoleDirectory` / workflow in-memory store; fast, deterministic tests. |
| Future read optimization | **Materialized projection / short-TTL cache behind the port** — deferred | Port isolation lets a read cache or projection be added at infrastructure-design without changing the public query surface ([[performance-requirements]], [[scalability-requirements]]); not built now (design-for-change). |

**Decision — no new persistence, no new port, no read cache at MVP.** Reusing
the workflow unit's repository port keeps the reversible decision reversible
(architecture guidance: "reversibility over perfection") and keeps a single
store seam. A dedicated CQRS read store is explicitly rejected for this scale.

## Integration & Cross-Unit Contracts

- **Identity** — reuse `AuthenticatedPrincipal` / `PrincipalId` from
  `unit-platform-auth` (`src/domain/entities.ts`) read-only; do not redefine
  identity value objects ([[business-logic-model]] Data Flow).
- **Authorization** — consume `{ AuthzService, requirePermission }` from
  `src/authz/index.ts` verbatim and pass `{ department }` as the `AuthzResource`;
  never re-derive roles or scope ([[business-logic-model]] Query Flows;
  [[business-rules]] `BR-SQ-2/3`). The three view permissions
  (`request:view-own`, `request:view-team`, `request:view-department`) come from
  the shipped closed permission set — invent none.
- **Read source** — read the `VacationRequest` aggregate and its append-only
  `history` through the `unit-request-workflow` `VacationRequestRepository` port
  only; never write, never invoke a transition, never reach past the port into
  workflow internals ([[business-logic-model]] Data Flow; [[business-rules]]
  `BR-SQ-15`).
- **Outbound** — none. Reads are pure and emit no domain events
  ([[business-rules]] `BR-SQ-15`); `audit-trail` records transitions, not views,
  so a status read is not an audited fact.
- **PII posture** — projections are PII-lean by construction; free-text `reason`
  is role-gated at projection time ([[business-rules]] `BR-SQ-6`) and redacted at
  every log boundary (`req-nfr-security-pii`, [[business-rules]] `BR-SQ-16`).

## Tooling, Testing & Conventions

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Build | **`tsc`** (`npm run build` / `typecheck`) | Existing scripts; no bundler needed for a server-side read unit. |
| Test runner | **Vitest** | Shipped test tool; root `vitest.config.ts` auto-globs `src/**/*.test.ts`, so `src/**` tests are picked up with no new config (authz / workflow `code-summary` precedent). |
| Lint | **ESLint** + `@typescript-eslint` | Existing `.eslintrc.cjs`; team `## Code Style` defers to project linter. |
| Coverage | **`@vitest/coverage-v8`**, keep project ≥ 80% line / 75% branch | Existing thresholds in `vitest.config.ts`; each query covers happy path + ≥ 2 error/edge cases (deny, out-of-scope omission, unknown id) per team `## Testing Standards`. |
| Frontend | **Server-rendered / static read views** consistent with `public/requests.html` | UI-bearing read surface (list rows, status badge, timeline) per the functional-design `frontend-components.md`; no new SPA framework introduced. |
| Secrets | **Env / secrets manager**, never hard-coded | Team `## Security` rule; `ADR-AUTH-04` precedent. This unit needs no secrets of its own (no store credentials — it reads through the shared port). |
| PII handling | **Role-gate reason; PII-free codes; redact at log boundary** | [[business-rules]] `BR-SQ-6/16`; `req-nfr-security-pii`. |

## Summary of Decisions

1. **Adopt** TypeScript + Node 20 + Express + ESM + `Result<T,E>` — no new
   language or framework for this read unit.
2. **Synchronous on-demand projection** over the shared append-only store — no
   separate CQRS read store at this scale; **reuse** the
   `VacationRequestRepository` port read-only rather than defining a parallel
   read port.
3. **In-memory** dev/test adapter (inherited); a **materialized projection /
   short-TTL cache** behind the port is a deferred, port-isolated option for
   infrastructure-design if read volume diverges.
4. **Consume** `unit-platform-auth`, `unit-platform-authz`, and
   `unit-request-workflow` surfaces read-only; emit **no** events; references
   **by id**.
5. **Vitest + ESLint + tsc**, coverage thresholds and PII/secret rules inherited
   from the shipped project and team practices.
