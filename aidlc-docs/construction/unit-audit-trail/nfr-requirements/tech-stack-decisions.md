---
consumes: [business-logic-model, business-rules, requirements]
unit: unit-audit-trail
stage: nfr-requirements
---

# Tech-Stack Decisions — `unit-audit-trail`

Technology selections and rationale for the **Immutable Audit Trail** unit. As
with the other units of this modular monolith, the dominant constraint is
**consistency with the already-shipped stack**: `unit-platform-auth`,
`unit-platform-authz`, `unit-hris-balance`, and `unit-request-workflow` are in
the tree with a fixed hexagonal layout, and this unit consumes the workflow's
published `WorkflowEvent` language read-only (unit `business-logic-model` Data
Flow; unit `domain-entities` Design note). Decisions therefore mostly **adopt**
the established stack rather than introduce new technology — the least-coupling,
design-for-change posture in the architecture guidance. Choices trace to the
event-sink shape in the unit's `business-logic-model`, the append-only /
hash-chain / retention invariants in its `business-rules` (`BR-AUD-5`,
`BR-AUD-6`, `BR-AUD-7`), and the constraints in `requirements`
(`req-constraint-append-only-store`, `req-nfr-audit-retention`,
`req-nfr-security-pii`, `req-constraint-build-gate`).

## Language, Runtime & Framework

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Language | **TypeScript 5.5** (strict) | Matches the shipped units; static types make the immutable `readonly` `AuditRecord`, the `AuditError` taxonomy, and `Result<T,E>` compile-checked. |
| Runtime | **Node.js ≥ 20** | Fixed by `package.json` `engines`; shared across all units. |
| HTTP framework | **Express 4** | Already the app's router; the read surface composes `requireSession → requirePermission → handler` on Express, exactly like the shipped units. |
| Module system | **ESM** with `.js` import specifiers | Mirrors the shipped `.js` ESM import convention. |
| Error model | **`Result<T, AuditError>`** (no throwing for expected failures) | Reuses `src/domain/result.ts`; mirrors the `SsoError` / `AuthzError` / `HrisError` / `WorkflowError` taxonomy per the unit `domain-entities`. |

**Decision — adopt the shipped stack; add no new runtime/framework.**
Introducing a different language or framework for one sink unit of a modular
monolith would fragment the build, duplicate the hexagonal seams, and break the
shared `requireSession`/`requirePermission` composition — more coupling for no
benefit. Rejected: a separate audit microservice in another language (premature
split — the units-generation topology keeps this an in-process unit consuming
the workflow's in-process event publisher); a heavier framework such as NestJS
(adds DI/decorator machinery the hand-wired ports do not need).

## Cryptography & Integrity

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Hash primitive | **SHA-256 via Node core `crypto`** | `business-rules` `BR-AUD-6` specifies a SHA-256 hash chain; Node's built-in `crypto` needs no new dependency and is FIPS-friendly. |
| Canonical serialization | **Purpose-built pure, version-tagged canonical serializer** | `business-rules` `BR-AUD-6a` requires stable key order + fixed number formatting for reproducible hashes; a small hand-rolled canonicaliser is auditable and avoids `JSON.stringify` key-order ambiguity. |
| Tamper-evidence model | **Per-`requestId` prev-hash chain** (MVP) | `BR-AUD-4`/`BR-AUD-6`; detect-tampering in-process with zero external dependency. |
| Cryptographic signing (non-repudiation) | **Deferred** to nfr-design / infrastructure-design, behind the `AuditStore` seam | Functional-design tradeoff: hash chain gives tamper-*evidence* now; KMS-backed signing adds non-*repudiation* but needs managed keys — a reversible enhancement, not MVP scope. |

**Decision — hash chain now, signing later, same seam.** This honours
"reversibility over perfection": the `AuditStore` port and canonical serializer
isolate the integrity mechanism, so signing can be layered on without reworking
the record shape or the ingest flow.

## Domain & Persistence

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Architecture style | **Hexagonal (ports & adapters)** within the modular monolith | Same seam as shipped units; the pure `AuditRecord`/`verifyChain` logic is unit-testable without a store (unit `domain-entities`). |
| Persistence contract | **`AuditStore` port — `append` + reads only, no `update`/`delete`** | `business-rules` `BR-AUD-5`; immutability is a **contract-level** guarantee — mutation cannot compile. This is the single most important persistence decision. |
| Dev/test adapter | **In-memory** append-only implementation | Mirrors shipped `InMemorySessionStore` / `InMemoryRoleDirectory`; fast deterministic tests. |
| Production adapter | **Durable append-only / WORM store** (decided at infrastructure-design) | Deferred deliberately behind the port to honour `req-constraint-build-gate` (no product procured at design time) and keep the reversible choice reversible; must enforce append-only at the storage layer and honour seven-year retention (`req-nfr-audit-retention`, `BR-AUD-7`). |
| Inbound integration | **Subscribe to the shipped `EventPublisher` port** via a thin anti-corruption mapper | Unit `domain-entities` `WorkflowEventSubscription`; consume `WorkflowEvent` verbatim, isolate audit from future event-shape drift (conformist-with-ACL). Never call the workflow unit back. |
| Cross-unit references | **By id, never object graph** | Store `requestId` / `ownerId` / `actorId` / `department` as opaque ids/codes (unit `domain-entities` Relationships); least coupling, PII-minimising (`BR-AUD-8`). |

**Decision — commit only to the append-only port contract now; defer the
concrete WORM store.** The port isolates the choice; a per-`requestId`-keyed
document/object store with object-lock/retention fits the single-key read +
append write pattern and the seven-year immutability requirement, but the
product is selected at infrastructure-design under the procurement gate.

## Tooling, Testing & Conventions

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Build | **`tsc`** (`npm run build` / `typecheck`) | Existing scripts; no bundler for a server-side unit. |
| Test runner | **Vitest** | Shipped test tool; root `vitest.config.ts` auto-globs `src/**/*.test.ts`, so this unit's tests are picked up with no new config. |
| Lint | **ESLint** + `@typescript-eslint` | Existing `.eslintrc.cjs`; team `## Code Style` defers to the project linter. |
| Coverage | **`@vitest/coverage-v8`**, keep project ≥ 80% line / 75% branch | Existing thresholds; each component covers happy path + ≥ 2 error/edge cases, including the integrity-violation and idempotent-duplicate paths. |
| Secrets | **Env / secrets manager**, never hard-coded | Team `## Security` rule; `ADR-AUTH-04` precedent — durable-store credentials injected. |
| PII handling | **Id-only logs; PII-free `AuditError` codes** | `business-rules` `BR-AUD-8`; `requirements` `req-nfr-security-pii`. |

## Summary of Decisions

1. **Adopt** TypeScript 5.5 + Node ≥ 20 + Express 4 + ESM + `Result<T, AuditError>`
   — no new language or framework for this unit.
2. **SHA-256 (Node core `crypto`)** hash chain with a **pure version-tagged
   canonical serializer**; cryptographic signing deferred behind the seam.
3. **Hexagonal** layout; pure `AuditRecord` + `verifyChain` behind an
   **`AuditStore` port with `append` + reads only** — no `update`/`delete`,
   immutability enforced at the type level.
4. **In-memory** dev/test adapter now; **durable append-only / WORM** production
   store decided at infrastructure-design (reversible, procurement-gated,
   seven-year retention).
5. **Subscribe** to the shipped `EventPublisher` via a thin ACL mapper; consume
   `WorkflowEvent` verbatim; references **by id**; never call the workflow back.
6. **Vitest + ESLint + tsc**, coverage thresholds and PII/secret rules inherited
   from the shipped project and team practices.
