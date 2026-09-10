# Code Generation Plan — unit-hris-balance

> Unit: **unit-hris-balance** — Display-Only HRIS Balance Adapter (read-only).
> Grounds: `business-logic-model` (unit-hris-balance), `business-rules`
> (unit-hris-balance), `domain-entities` (unit-hris-balance),
> `performance-design` (unit-hris-balance), `security-design`
> (unit-hris-balance), `deployment-architecture` (unit-hris-balance),
> `unit-of-work`, `requirements`. Depends on the already-completed
> `unit-platform-auth` (authenticated identity is inherited; this unit adds no
> auth path of its own).

## Story-to-code-step traceability

| Story | Requirement(s) | Plan steps |
|-------|----------------|------------|
| `story-display-balance` — View display-only leave balance from HRIS | `req-display-only-balance`, `req-constraint-hris-system-of-record` | Steps 2–9 |

Cross-cutting constraints threaded through every step:
- `req-constraint-hris-system-of-record` — HRIS is the system of record;
  balances are **read-only** (no write path on any branch).
- `req-display-only-balance` — the projection is advisory / display-only.
- `req-nfr-security-pii` — employee balance data is PII (per the
  `security-design` and `business-rules` PII policy).
- Non-blocking degradation to a typed *unavailable* outcome
  (`business-logic-model` read-through workflow; `performance-design` 800ms
  timeout + degraded-outcome handling instead of inline retries).

## Steps

- [x] **Step 1 — Domain read-model & Result types.**
  `src/hris/domain/balance.ts`: immutable `LeaveBalance` value object,
  `BalanceOutcome` union (`available` | `unavailable` with a typed reason),
  `EmployeeRef`, freshness (`asOf`, `stale`) fields, and a `HrisError`
  taxonomy. Reuse the existing `src/domain/result.ts` `Result<T,E>`.
  (`domain-entities`, `req-display-only-balance`)

- [x] **Step 2 — HRIS anti-corruption port.**
  `src/hris/ports/hris-client.ts`: `HrisClientPort` interface — a single
  read-only `fetchRawBalance(employeeRef)` method returning the raw HRIS
  shape; no mutating methods exist. This is the system-of-record boundary
  (`req-constraint-hris-system-of-record`, `business-logic-model`).

- [x] **Step 3 — Balance cache port + in-memory cache-aside adapter.**
  `src/hris/ports/balance-cache.ts` (port) and
  `src/hris/adapters/in-memory-balance-cache.ts` (short-TTL cache-aside impl,
  clock-injected). (`performance-design` caching architecture)

- [x] **Step 4 — Stub HRIS adapter.**
  `src/hris/adapters/stub-hris-client.ts`: walking-skeleton `HrisClientPort`
  impl (seeded map + optional latency/failure injection) so the service is
  testable without a live HRIS. Production swaps a real SDK behind the port.

- [x] **Step 5 — Business logic layer (read-through service).**
  `src/hris/services/balance-service.ts`: `getBalance(employeeRef)` →
  `Result<BalanceOutcome, HrisError>`. Cache-aside read, 800ms timeout,
  non-blocking degradation to `unavailable` on timeout/transport/HRIS fault,
  PII-safe mapping to the display read-model, freshness/staleness marking.
  (`business-logic-model`, `business-rules`, `performance-design`)

- [x] **Step 6 — Business logic tests.**
  `src/hris/services/balance-service.test.ts`: happy path (available, fresh),
  cache hit, timeout → non-blocking `unavailable`, HRIS fault → `unavailable`,
  stale-on-serve, PII not leaked in error/outcome. (Standard strategy: 5–8
  tests.)

- [x] **Step 7 — Config.**
  `src/hris/config/balance-policy.ts`: injected `BalancePolicy`
  (`fetchTimeoutMs` default 800, `cacheTtlSeconds` short default, `staleAfterSeconds`).
  No secrets hard-coded. (`performance-design`, `deployment-architecture` IaC approach)

- [x] **Step 8 — HTTP endpoint layer.**
  `src/hris/http/balance-router.ts`: `GET /me/leave-balance` guarded by the
  existing `requireSession` middleware (inherits authentication from
  `unit-platform-auth`; authorization deferred per `security-design`). Maps
  `available`/`unavailable` outcomes to a stable JSON envelope with
  `Cache-Control: no-store`. Scopes the read to the authenticated principal
  (own balance only). (`story-display-balance`, `security-design`)

- [x] **Step 9 — HTTP tests.**
  `src/hris/http/balance-router.test.ts`: 401 when unauthenticated,
  200 available, 200 degraded/unavailable envelope, own-principal scoping.

- [x] **Step 10 — Cache adapter tests.**
  `src/hris/adapters/in-memory-balance-cache.test.ts`: set/get, TTL expiry,
  miss. (per-component happy-path floor)

- [x] **Step 11 — Composition helper.**
  `src/hris/hris-balance.ts`: `createBalanceService(...)` /
  `mountBalanceRoutes(app, deps)` wiring helper so the modular monolith
  composition root can mount this unit in-process (`deployment-architecture`
  compute model — in-process within the shared app tier).

- [x] **Step 12 — Test configuration.**
  Reuse the existing root `vitest.config.ts` (already globs
  `src/**/*.test.ts`) — no new config file needed; verify new tests are
  picked up. Document this in the summary.

- [x] **Step 13 — Documentation & verification.**
  Inline doc comments on every module (matching the auth unit's style);
  run `npm run typecheck`, `npm run lint`, and `npm test`; then write
  `code-summary.md`.
