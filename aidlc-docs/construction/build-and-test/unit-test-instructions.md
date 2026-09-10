# Unit Test Instructions — Vacation Request App

Owner: aidlc-quality-agent. Strategy level: **Comprehensive** (enterprise
scope). Per-component model, 10–15 tests per component, pyramid proportions
(≈75% unit) applied within the generated set. These instructions describe the
unit-test layer that already ships with each unit's `code-generation` output
(see the per-unit [[code-summary]] and the step-by-step [[code-generation-plan]])
and the standard every future unit test must meet.

## Framework setup and configuration

- **Runner**: Vitest (`vitest run`), configured in `vitest.config.ts` with
  `globals: true`, `environment: 'node'`, `include: ['src/**/*.test.ts']`.
- **Coverage provider**: `@vitest/coverage-v8`, reporters `text` + `lcov`.
- **Coverage config excludes** `*.test.ts`, `index.ts` (thin wiring),
  `server.ts`, and `openid-client-adapter.ts` (thin wrapper over the certified
  library, exercised against a live IdP in integration, not unit tests).
- Tests co-locate with source as `*.test.ts` beside the module under test
  (e.g. `src/workflow/services/workflow-service.test.ts`).

## How to run

```bash
npm test                              # vitest run — whole suite (33 files)
npx vitest run --coverage             # with coverage + threshold gate
npx vitest run src/workflow           # one unit's tests
npx vitest run src/authz/services/authz-service.test.ts   # one file
npx vitest --watch                    # watch mode for local dev
npx vitest run -t "fail-closed"       # filter by test name substring
```

## Coverage targets (Comprehensive)

Enforced by `vitest.config.ts` thresholds — the run **fails** below any of:

| Metric | Threshold |
|--------|-----------|
| Lines | ≥ 80% |
| Statements | ≥ 80% |
| Functions | ≥ 80% |
| Branches | ≥ 75% |

Current whole-repo actuals (baseline): **96.9% lines / 85.2% branches** — well
above the gate. Domain and service modules should sit at or near 100%; thin
HTTP routers and error factories carry the branch slack.

## Per-component coverage expectations

Every unit follows the same three-layer split (domain / service / adapter),
each with dedicated unit tests. Tests must validate the **requirement**, not
the implementation:

- **Domain (value objects, policies, entities, errors)** — construction
  validation, invariants, and state-transition guards. Cover boundary and
  illegal-input cases. Examples: `workflow/domain/vacation-request.test.ts`,
  `authz/domain/role-policy.test.ts`, `sla-escalation/domain/sla-policy.test.ts`.
- **Service (application logic / orchestration)** — happy path per operation
  **plus** every fail-closed / deny branch. The auth `AuthService` covers the
  eight ordered assertion checks; every command service asserts
  authorization-before-state (deny short-circuits touch no state). Examples:
  `services/auth-service.test.ts`, `workflow/services/workflow-service.test.ts`,
  `authz/services/authz-service.test.ts`.
- **Adapter (in-memory ports)** — round-trip persistence, ordering, optimistic
  concurrency, and miss/not-found behaviour. Examples:
  `adapters/in-memory-session-store.test.ts`,
  `workflow/adapters/*repository*` (concurrency), audit store append/read-back.

## Requirement-driven floor (must-have unit tests)

Each of these behaviours has at least one dedicated unit test; treat as
regression floor:

- **Auth**: eight ordered fail-closed checks; session mint/verify; revocation;
  logout idempotency (`req-sso-authentication`, `req-constraint-sso-mandatory`).
- **Authz**: per-role grant table; no cross-role inheritance; deny-by-default;
  per-department HR scoping (`req-rbac-three-roles-hr-scoping`).
- **Workflow**: submit; team-lead validate/reject only; HR approve/reject only,
  no override; status transitions (`req-submit-vacation-request`,
  `req-team-lead-approve-reject`, `req-hr-approve-reject-no-override`).
- **Audit**: one immutable record per event; hash-chain link; `verifyChain`;
  PII-free record shape; retention stamp (`req-immutable-audit-trail`,
  `req-nfr-audit-retention`).
- **HRIS balance**: display-only read; no write path (`req-display-only-balance`).
- **Overlap**: overlap present/none; rejected/withdrawn excluded; self-exclusion;
  PII-free shape; fail-open (`req-overlap-indicator`).
- **Notifications**: recipient policy; template rendering; email + in-app
  channels (`req-notifications-email-inapp`).
- **SLA escalation**: reminder scheduling; breach detection; escalation target
  resolution (`req-sla-reminder-escalation`).
- **Status query**: role-scoped status read across roles (`req-status-tracking`).

## Test data management

- Construct fixtures in-test via factory helpers / builders; no shared mutable
  state between tests (independence is non-negotiable).
- In-memory adapters are the fakes for persistence; each test seeds its own
  aggregate. Where a repository enforces optimistic concurrency, seed the v1
  aggregate before persisting a v2 transition (see the sla-escalation
  `code-summary` test-seed note).
- No PII in fixtures — use pseudonymous ids only, matching the production
  PII-free-by-construction posture.
