# Tech-Stack Decisions — `unit-request-workflow`

Technology selections and rationale for the **Vacation Request Workflow** unit.
The dominant constraint is **consistency with the already-shipped modular
monolith**: `unit-platform-auth`, `unit-platform-authz`, and `unit-hris-balance`
are in the tree with a fixed stack and hexagonal layout, and this unit consumes
their public surfaces read-only ([[business-logic-model]] Data Flow;
[[domain-entities]] Design note). Decisions therefore mostly **adopt** the
established stack rather than introduce new technology — the least-coupling,
design-for-change posture in the architecture guidance and the team `## Way of
Working` / `## Code Style` rules. Choices trace to the workflow shape in
[[business-logic-model]], the invariants in [[business-rules]], and the
constraints in [[requirements]] (`req-constraint-append-only-store`,
`req-nfr-security-pii`, `req-constraint-build-gate`).

## Language, Runtime & Framework

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Language | **TypeScript 5.5** (strict) | Matches the shipped units; static types make the state-machine transitions and `Result<T,E>` errors compile-checked. |
| Runtime | **Node.js ≥ 20** | Fixed by `package.json` `engines`; shared across all units. |
| HTTP framework | **Express 4** | Already the app's router; the unit composes `requireSession → requirePermission → handler` on Express, per the authz `code-summary`. |
| Module system | **ESM** with `.js` import specifiers | Mirrors the shipped `.js` ESM import convention (authz `code-summary`). |
| Error model | **`Result<T, WorkflowError>`** (no throwing for expected failures) | Reuses `src/domain/result.ts`; mirrors `SsoError` / `AuthzError` / `HrisError` taxonomy ([[business-logic-model]] Error handling, [[business-rules]] deny-by-default). |

**Decision — adopt the shipped stack, add no new runtime/framework
dependency.** Introducing a different language or web framework for one unit of
a modular monolith would fragment the build, duplicate the hexagonal seams, and
break the shared `requireSession`/`requirePermission` composition — a net
increase in coupling for no benefit. Rejected alternatives: a separate service
in another language (premature microservice split — the units-generation
topology keeps this an in-process unit); a heavier framework such as NestJS
(adds DI/decorator machinery the existing plain-Express + hand-wired ports do
not need).

## Domain & Persistence

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Architecture style | **Hexagonal (ports & adapters)** within the modular monolith | Same seam as shipped units; the pure aggregate is unit-testable without a store ([[domain-entities]]). |
| Aggregate modelling | **Explicit finite state machine** over `VacationRequest` | The two-stage, approve/reject-only, no-override workflow maps to guarded transitions ([[business-logic-model]], [[business-rules]] `BR-WF-*`). |
| Persistence contract | **`VacationRequestRepository` port**, one per aggregate root | DDD repository rule; swaps in-memory dev/test for durable prod adapter with no service change ([[domain-entities]]). |
| Store semantics | **Append-only** (never overwrite history) | `req-constraint-append-only-store`, [[business-rules]] `BR-INV-4`; feeds the immutable `audit-trail`. |
| Dev/test adapter | **In-memory** implementation | Mirrors shipped `InMemorySessionStore` / `InMemoryRoleDirectory`; fast deterministic tests. |
| Production adapter | **Durable append-only store** (decided at infrastructure-design) | Deferred deliberately — the port isolates the choice; a document/key-value store keyed by `RequestId` fits the single-key read + append write pattern. |
| Concurrency control | **Optimistic (version token)**, not locking | Low contention (one lead, then one HR approver); avoids held locks on the hot path ([[business-rules]] `BR-INV-2/3`). |

**Decision — defer the concrete production store to infrastructure-design,
commit only to the append-only port contract now.** This keeps the reversible
decision reversible (architecture guidance: "reversibility over perfection")
and honours the `req-constraint-build-gate` procurement gate — no store product
is procured at design time.

## Integration & Cross-Unit Contracts

- **Authorization** — consume `{ AuthzService, requirePermission,
  InMemoryRoleDirectory }` from `src/authz/index.js` verbatim; never re-derive
  roles or scope ([[business-logic-model]] Data Flow; [[business-rules]]
  `BR-WF-8`). Production swaps `InMemoryRoleDirectory` for a
  directory-backed adapter with no PDP change (authz `code-summary`).
- **Identity** — reuse `AuthenticatedPrincipal` / `PrincipalId` from
  `unit-platform-auth` (`src/domain/entities.ts`) read-only ([[domain-entities]]
  Design note); do not redefine identity value objects.
- **Side-effects** — emit past-tense domain events (`RequestSubmitted`,
  `RequestValidated`, `RequestApproved`, `RequestRejected`, `RequestWithdrawn`)
  to a choreography bus; consumers (`audit-trail`, `notification`,
  `overlap-indicator`) subscribe. Cross-unit references are **by id, not object
  graph** ([[domain-entities]] Relationships).
- **Balance** — read the display-only HRIS balance from `unit-hris-balance` for
  UI/approver context only; never a write target or submission gate
  ([[business-rules]] `BR-VAL-6`).

## Tooling, Testing & Conventions

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Build | **`tsc`** (`npm run build` / `typecheck`) | Existing scripts; no bundler needed for a server-side unit. |
| Test runner | **Vitest** | Shipped test tool; root `vitest.config.ts` auto-globs `src/**/*.test.ts`, so `src/**` tests are picked up with no new config (authz `code-summary` precedent). |
| Lint | **ESLint** + `@typescript-eslint` | Existing `.eslintrc.cjs`; team `## Code Style` defers to project linter. |
| Coverage | **`@vitest/coverage-v8`**, keep project ≥ 80% line / 75% branch | Existing thresholds in `vitest.config.ts`; each component covers happy path + ≥ 2 error/edge cases (team `## Testing Standards`). |
| Secrets | **Env / secrets manager**, never hard-coded | Team `## Security` rule; `ADR-AUTH-04` precedent. |
| PII handling | **Redact reason at log boundaries; PII-free codes** | [[business-rules]] `BR-INV-6`; `req-nfr-security-pii`. |

## Summary of Decisions

1. **Adopt** TypeScript + Node 20 + Express + ESM + `Result<T,E>` — no new
   language or framework for this unit.
2. **Hexagonal** layout; pure FSM aggregate behind a `VacationRequestRepository`
   port with an **append-only** contract.
3. **In-memory** dev/test adapter now; **durable append-only** production store
   decided at infrastructure-design (reversible, procurement-gated).
4. **Optimistic concurrency** over locking.
5. **Consume** `unit-platform-authz` and `unit-platform-auth` surfaces read-only;
   integrate side-effects via **event choreography**, references **by id**.
6. **Vitest + ESLint + tsc**, coverage thresholds and PII/secret rules inherited
   from the shipped project and team practices.
