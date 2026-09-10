# Test Results — Vacation Request App

Executed by aidlc-quality-agent during the build-and-test stage against the
working-tree checkout. Verifies the aggregate build and the shipped test suites
described in the per-unit [[code-summary]] and [[code-generation-plan]].

## Environment

- Node.js v24.15.0 (satisfies `engines.node >= 20`), npm 11.12.1.
- `npm install` — 310 packages added from the pinned lockfile, exit 0.
- No env vars / external services required (in-memory ports).

## Build status — PASS

| Step | Command | Exit | Result |
|------|---------|------|--------|
| Type check | `npm run typecheck` (`tsc --noEmit`, strict) | 0 | clean, no type errors |
| Lint | `npm run lint` (`eslint . --ext .ts`) | 0 | clean, no warnings/errors |
| Build | `npm run build` (`tsc -p tsconfig.json`) | 0 | `dist/` emitted, then cleaned |

## Test results — PASS

| Metric | Value |
|--------|-------|
| Test files | 33 passed (33) |
| Tests | **250 passed (250)** |
| Failed | 0 |
| Skipped | 0 |
| Duration | ~9.5 s |

Command: `npx vitest run --coverage` (exit 0).

### Per-unit test file counts (aggregated across the 33 files)

- auth (`unit-platform-auth`): `auth-service.test.ts`, `auth-router.test.ts`,
  `in-memory-session-store.test.ts`, `jose-token-signer.test.ts`.
- authz (`unit-platform-authz`): `authz-service.test.ts`, `role-policy.test.ts`,
  `in-memory-role-directory.test.ts`, `require-permission.test.ts`.
- workflow (`unit-request-workflow`): `vacation-request.test.ts`,
  `workflow-service.test.ts`, `workflow-router.test.ts`.
- hris (`unit-hris-balance`): `balance-service.test.ts`, `balance-router.test.ts`,
  `in-memory-balance-cache.test.ts`.
- audit (`unit-audit-trail`): `audit-service.test.ts`, `audit-router.test.ts`,
  `in-memory-audit-store.test.ts`.
- overlap (`unit-overlap-indicator`): `overlap-service.test.ts`,
  `overlap-router.test.ts`.
- notifications (`unit-notifications`): `notification-service.test.ts`,
  `notification-router.test.ts`, `recipient-policy.test.ts`, `templates.test.ts`,
  `in-memory-in-app-inbox.test.ts`, `notification-choreography.test.ts`.
- status-query (`unit-status-query`): `status-query-service.test.ts`,
  `status-query-router.test.ts`.
- sla-escalation (`unit-sla-escalation`): `sla-scan-service.test.ts`,
  `sla-policy.test.ts`, `templates.test.ts`, `sla-router.test.ts`,
  `in-memory-reminder-ledger.test.ts`, `adapters.test.ts`.

## Coverage report — PASS (thresholds met)

Whole-repo aggregate (v8 provider):

| Metric | Threshold | Actual | Status |
|--------|-----------|--------|--------|
| Statements | ≥ 80% | 96.92% | PASS |
| Branches | ≥ 75% | 85.15% | PASS |
| Functions | ≥ 80% | 95.75% | PASS |
| Lines | ≥ 80% | 96.92% | PASS |

Domain and service modules sit at or near 100%. The lowest branch coverage is
in thin HTTP routers (e.g. `workflow-router.ts` 45.9% branch,
`status-query-router.ts` 60% branch) and error factories — the aggregate branch
gate is still comfortably met. `index.ts`, `subscribe.ts`, `server.ts`, and the
`openid-client-adapter.ts` wrapper are excluded by the coverage config
(thin wiring / live-IdP integration).

## Failure details

None — build, lint, type-check, and all 250 tests passed on the first run after
dependency install. No fixes were required.

## Notes

- The reported 250/250 matches the last unit's (`unit-sla-escalation`)
  `code-summary` claim of 250 tests across 33 files — no regressions between
  code-generation and this stage.
- `npm audit` reports advisories (3 low / 3 moderate / 4 high / 2 critical
  across the full dev+runtime tree); these are recorded for the devsecops SCA
  gate (see `security-test-instructions.md`) and were not auto-fixed here to
  avoid breaking-change bumps inside the build gate.
