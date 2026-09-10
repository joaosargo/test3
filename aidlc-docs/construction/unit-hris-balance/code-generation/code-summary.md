# Code Summary — unit-hris-balance

Display-only HRIS leave-balance adapter for the vacation-request modular
monolith. Implements `story-display-balance`, satisfying
`req-display-only-balance` and `req-constraint-hris-system-of-record`.
Grounded in the unit-hris-balance `business-logic-model`, `business-rules`,
`domain-entities`, `performance-design`, `security-design`, and
`deployment-architecture` artifacts, plus `unit-of-work` and `requirements`.
Depends on the completed `unit-platform-auth` (authenticated identity is
inherited; this unit adds no auth path).

## Files created

All under the existing hexagonal layout, in a new `src/hris/` subtree to keep
the unit self-contained and independently testable:

| File | Layer | Purpose |
|------|-------|---------|
| `src/hris/domain/balance.ts` | Domain | Immutable `LeaveBalance` read-model, `BalanceOutcome` union (available/unavailable), `HrisError` taxonomy |
| `src/hris/ports/hris-client.ts` | Port | Read-only `HrisClientPort` anti-corruption boundary to the HRIS system of record |
| `src/hris/ports/balance-cache.ts` | Port | `BalanceCache` short-TTL cache-aside port |
| `src/hris/adapters/stub-hris-client.ts` | Adapter | Walking-skeleton HRIS client with latency/failure injection |
| `src/hris/adapters/in-memory-balance-cache.ts` | Adapter | In-memory cache-aside impl (clock-injected TTL) |
| `src/hris/services/balance-service.ts` | Service | `getBalance` read-through: cache-aside, 800ms timeout, non-blocking degradation, PII-safe projection |
| `src/hris/config/balance-policy.ts` | Config | Injected `BalancePolicy` (timeout, cache TTL, staleness) |
| `src/hris/http/balance-router.ts` | HTTP | Guarded `GET /me/leave-balance`, own-principal scoping, `Cache-Control: no-store` |
| `src/hris/hris-balance.ts` | Composition | `createBalanceService` / `mountBalanceRoutes` in-process wiring helpers |
| `src/hris/services/balance-service.test.ts` | Test | 8 service unit tests |
| `src/hris/http/balance-router.test.ts` | Test | 3 HTTP integration tests |
| `src/hris/adapters/in-memory-balance-cache.test.ts` | Test | 3 cache adapter tests |

No existing files were modified — this is an additive, in-process unit that
reuses `src/domain/result.ts`, the `requireSession` middleware, and the
`AuthService` from `unit-platform-auth` without changing them.

## Key implementation decisions

- **Read-only by construction** (`req-constraint-hris-system-of-record`): the
  `HrisClientPort` exposes only `fetchRawBalance`; no mutating method exists on
  any branch.
- **Non-blocking degradation** (`business-logic-model`, `performance-design`):
  timeout / transport fault / malformed payload / missing record all resolve to
  a typed `unavailable` OUTCOME carried inside `Result.ok`, never a thrown error
  and never an inline retry. `Result.err` is reserved for hard faults (invalid
  input). The 800ms fetch budget is enforced via a `Promise.race` timeout.
- **Cache-aside with short TTL** (`performance-design`): a hit short-circuits
  the HRIS round-trip; cache get/set are best-effort and their failures never
  block the display path.
- **PII protection** (`security-design`, `req-nfr-security-pii`): outcome/error
  shapes carry no raw HRIS payloads, balances, or employee identifiers; the
  HTTP response sets `Cache-Control: no-store`.
- **Authentication inherited, authorization deferred** (`security-design`): the
  route is guarded by the shared `requireSession` middleware and scoped to the
  authenticated principal's own balance (the session subject IS the employee
  reference) — no cross-employee lookup is possible.
- **In-process deployment** (`deployment-architecture`): mounted onto the shared
  Express app via composition helpers, not a separate service.

## Test coverage summary

- 14 new tests (8 service + 3 HTTP + 3 cache); full suite: **47 passing, 0
  regressions** across 7 test files.
- Coverage for `src/hris`: ~97% statements / 86% branches — above the
  configured thresholds (lines/functions/statements 80%, branches 75%).
- Verification run: `npm run typecheck` (clean), `npm run lint` (clean),
  `npm test` (47/47), `npx vitest run --coverage` (thresholds met).

## Deviations from the plan

- **Step 12 (test configuration):** no new config file was needed — the root
  `vitest.config.ts` already globs `src/**/*.test.ts`, so the new tests are
  picked up automatically. Documented rather than duplicated.
- All other plan steps (1–11, 13) were implemented as written.
